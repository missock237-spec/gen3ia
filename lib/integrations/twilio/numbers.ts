import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { getTwilioConfig, isValidE164 } from "./voice";
import { reserveFunds, releaseReservation, settleReservation } from "@/lib/billing/wallet";
import { getNumberPricing, usdMinorToWalletMinor } from "@/lib/voice/pricing";

const COLLECTION = "agentPhoneNumbers";
const DEFAULT_PRICE_MINOR = 5000;

function authHeader(accountSid: string, authToken: string) {
  return "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64");
}

function apiBase(accountSid: string) {
  return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
}

function configuredPriceMinor() {
  const value = Number(process.env.GEN3IA_PHONE_NUMBER_PRICE_MINOR ?? DEFAULT_PRICE_MINOR);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PRICE_MINOR;
}

async function twilioRequest(path: string, init: RequestInit = {}) {
  const config = getTwilioConfig();
  const response = await fetch(apiBase(config.accountSid) + path, {
    ...init,
    headers: {
      Authorization: authHeader(config.accountSid, config.authToken),
      ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.message ?? payload.detail ?? `Twilio HTTP ${response.status}`));
  }
  return payload as Record<string, unknown>;
}

export interface AgentPhoneNumber {
  id: string;
  ownerId: string;
  agentId: string;
  phoneNumber: string;
  twilioSid: string;
  provider?: "twilio" | "plivo";
  source: "gen3ia" | "own";
  status: "active" | "pending" | "released";
  createdAt: number;
  updatedAt: number;
}

export async function listAgentPhoneNumbers(ownerId: string, agentId?: string) {
  const snap = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).limit(100).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<AgentPhoneNumber, "id">) })).filter((item) => !agentId || item.agentId === agentId);
}

async function configureTwilioNumber(phoneSid: string, sessionId: string) {
  const config = getTwilioConfig();
  const voiceUrl = `${config.appUrl}/api/voice/twilio/answer?numberId=${encodeURIComponent(sessionId)}`;
  const statusUrl = `${config.appUrl}/api/voice/twilio/status?numberId=${encodeURIComponent(sessionId)}`;
  const body = new URLSearchParams({
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
    StatusCallback: statusUrl,
    StatusCallbackMethod: "POST",
  });
  await twilioRequest(`/IncomingPhoneNumbers/${encodeURIComponent(phoneSid)}.json`, { method: "POST", body });
}

export async function searchAvailableNumbers(country: string, areaCode?: string, limit = 10) {
  const normalizedCountry = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedCountry)) throw new Error("Country must be an ISO-3166 alpha-2 code.");
  const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: String(Math.min(20, Math.max(1, limit))) });
  if (areaCode?.trim()) query.set("AreaCode", areaCode.trim());
  const [payload, pricing] = await Promise.all([
    twilioRequest(`/AvailablePhoneNumbers/${normalizedCountry}/Local.json?${query.toString()}`),
    // Tarification margée (fournisseur + 20 %), calculée une fois par pays
    // et servie à l'UI pour un achat éclairé.
    getNumberPricing(normalizedCountry).catch(() => null),
  ]);
  const numbers = Array.isArray(payload.available_phone_numbers) ? payload.available_phone_numbers : [];
  return numbers.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      phoneNumber: String(value.phone_number ?? ""),
      friendlyName: String(value.friendly_name ?? value.phone_number ?? ""),
      locality: String(value.locality ?? ""),
      region: String(value.region ?? ""),
      isoCountry: String(value.iso_country ?? normalizedCountry),
      capabilities: value.capabilities ?? { voice: true },
      pricing,
    };
  }).filter((item) => isValidE164(item.phoneNumber));
}

export async function purchaseNumberForAgent(params: { ownerId: string; agentId: string; phoneNumber: string }) {
  if (!isValidE164(params.phoneNumber)) throw new Error("Phone number must use E.164 format.");
  const existing = await listAgentPhoneNumbers(params.ownerId, params.agentId);
  if (existing.some((item) => item.status === "active")) throw new Error("This agent already has an active phone number.");

  // Prix vendu = prix fournisseur + marge (défaut 20 %) — ex. 5,00 USD/mois
  // chez le fournisseur ⇒ 6,00 USD/mois côté client. Débit wallet converti
  // explicitement (GEN3IA_USD_TO_XAF) et journalisé dans le metadata.
  const pricing = await getNumberPricing(params.phoneNumber.slice(0, 2) === "+1" ? "US" : params.phoneNumber.slice(1, 3));
  const sellPriceUsdMinor = pricing.sellPriceUsdMinor;
  const chargeMinor = usdMinorToWalletMinor(sellPriceUsdMinor);
  const reference = `phone-number-${params.agentId}-${params.phoneNumber}`;
  await reserveFunds({
    userId: params.ownerId,
    amountMinor: chargeMinor,
    reference,
    metadata: {
      product: "gen3ia_phone_number",
      agentId: params.agentId,
      phoneNumber: params.phoneNumber,
      sellPriceUsdMinor: String(sellPriceUsdMinor),
      providerPriceUsdMinor: String(pricing.providerPriceUsdMinor),
      markupBps: String(pricing.markupBps),
    },
  });

  let purchasedSid = "";
  try {
    const body = new URLSearchParams({ PhoneNumber: params.phoneNumber, FriendlyName: `Gen3ia Agent ${params.agentId.slice(0, 8)}` });
    const purchased = await twilioRequest("/IncomingPhoneNumbers.json", { method: "POST", body });
    purchasedSid = String(purchased.sid ?? "");
    const phone = String(purchased.phone_number ?? params.phoneNumber);
    if (!purchasedSid) throw new Error("Twilio did not return a phone-number SID.");

    await configureTwilioNumber(purchasedSid, params.agentId);
    const doc = adminDb.collection(COLLECTION).doc();
    const now = Date.now();
    const nextRenewalAt = now + 30 * 24 * 60 * 60 * 1000;
    const record: AgentPhoneNumber = {
      id: doc.id,
      ownerId: params.ownerId,
      agentId: params.agentId,
      phoneNumber: phone,
      twilioSid: purchasedSid,
      provider: "twilio",
      source: "gen3ia",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await doc.set({
      ...record,
      providerPriceUsdMinor: pricing.providerPriceUsdMinor,
      sellPriceUsdMinor,
      markupBps: pricing.markupBps,
      monthlyChargeMinor: chargeMinor,
      nextRenewalAt: Timestamp.fromMillis(nextRenewalAt),
    });
    await settleReservation({
      userId: params.ownerId,
      reference,
      reservedMinor: chargeMinor,
      actualChargeMinor: chargeMinor,
      metadata: { product: "gen3ia_phone_number", agentId: params.agentId, twilioSid: purchasedSid, sellPriceUsdMinor: String(sellPriceUsdMinor) },
    });
    return { ...record, sellPriceUsdMinor, providerPriceUsdMinor: pricing.providerPriceUsdMinor, chargeMinor, nextRenewalAt };
  } catch (error) {
    if (purchasedSid) await twilioRequest(`/IncomingPhoneNumbers/${encodeURIComponent(purchasedSid)}.json`, { method: "DELETE" }).catch(() => undefined);
    await releaseReservation({ userId: params.ownerId, reference, reservedMinor: chargeMinor }).catch(() => undefined);
    throw error;
  }
}

export async function attachExistingTwilioNumber(params: { ownerId: string; agentId: string; phoneNumber: string }) {
  if (!isValidE164(params.phoneNumber)) throw new Error("Phone number must use E.164 format.");
  const payload = await twilioRequest(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(params.phoneNumber)}`);
  const numbers = Array.isArray(payload.incoming_phone_numbers) ? payload.incoming_phone_numbers : [];
  const match = numbers.find((item) => String((item as Record<string, unknown>).phone_number ?? "") === params.phoneNumber) as Record<string, unknown> | undefined;
  if (!match?.sid) {
    throw new Error("Ce numéro n'est pas encore hébergé dans le compte téléphonique Gen3ia. Pour conserver votre numéro opérateur, il faut le porter/héberger chez Twilio avant de l'attribuer à l'agent.");
  }

  const sid = String(match.sid);
  await configureTwilioNumber(sid, params.agentId);
  const doc = adminDb.collection(COLLECTION).doc();
  const now = Date.now();
  const record: AgentPhoneNumber = {
    id: doc.id,
    ownerId: params.ownerId,
    agentId: params.agentId,
    phoneNumber: params.phoneNumber,
    twilioSid: sid,
    provider: "twilio",
    source: "own",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await doc.set(record);
  return record;
}

export async function getAgentPhoneNumberByNumber(phoneNumber: string) {
  const snap = await adminDb.collection(COLLECTION).where("phoneNumber", "==", phoneNumber).limit(5).get();
  const match = snap.docs.find((doc) => doc.data().status === "active");
  if (!match) return null;
  return { id: match.id, ...(match.data() as Omit<AgentPhoneNumber, "id">) };
}

export async function getAgentPhoneNumberById(id: string) {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as Omit<AgentPhoneNumber, "id">) };
}

export async function releaseAgentPhoneNumber(ownerId: string, id: string) {
  const record = await getAgentPhoneNumberById(id);
  if (!record || record.ownerId !== ownerId) throw new Error("Phone number not found.");
  await twilioRequest(`/IncomingPhoneNumbers/${encodeURIComponent(record.twilioSid)}.json`, { method: "DELETE" });
  await adminDb.collection(COLLECTION).doc(id).update({ status: "released", updatedAt: FieldValue.serverTimestamp() });
}
