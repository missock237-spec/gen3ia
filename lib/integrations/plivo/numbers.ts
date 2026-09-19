import { adminDb } from "@/lib/firebase/admin";
import { reserveFunds, releaseReservation, settleReservation } from "@/lib/billing/wallet";
import { isValidE164 } from "@/lib/integrations/twilio/voice";

const COLLECTION = "agentPhoneNumbers";
const DEFAULT_PRICE_MINOR = 5000;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is not configured.");
  return value;
}

function config() {
  return {
    authId: requiredEnv("PLIVO_AUTH_ID"),
    authToken: requiredEnv("PLIVO_AUTH_TOKEN"),
    appUrl: requiredEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, ""),
  };
}

function authHeader() {
  const c = config();
  return "Basic " + Buffer.from(c.authId + ":" + c.authToken).toString("base64");
}

async function requestPlivo(path: string, init: RequestInit = {}) {
  const response = await fetch("https://api.plivo.com/v1/Account/" + encodeURIComponent(config().authId) + path, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.message ?? payload.error ?? "Plivo request failed."));
  return payload as Record<string, unknown>;
}

function priceMinor() {
  const value = Number(process.env.GEN3IA_PHONE_NUMBER_PRICE_MINOR ?? DEFAULT_PRICE_MINOR);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PRICE_MINOR;
}

export async function searchAvailablePlivoNumbers(country: string, areaCode?: string, limit = 10) {
  const query = new URLSearchParams({
    country_iso: country.trim().toUpperCase(),
    limit: String(Math.min(20, Math.max(1, limit))),
    services: "voice",
  });
  if (areaCode?.trim()) query.set("pattern", areaCode.trim());
  const payload = await requestPlivo("/PhoneNumber/?" + query.toString());
  const raw = Array.isArray(payload.objects) ? payload.objects : Array.isArray(payload.phone_numbers) ? payload.phone_numbers : [];
  return raw.map((item) => {
    const v = item as Record<string, unknown>;
    const number = String(v.number ?? v.phone_number ?? "");
    return {
      phoneNumber: number,
      friendlyName: String(v.alias ?? number),
      locality: String(v.region ?? v.locality ?? ""),
      region: String(v.region ?? ""),
      isoCountry: String(v.country_iso ?? country).toUpperCase(),
      capabilities: { voice: true },
    };
  }).filter((item) => isValidE164(item.phoneNumber));
}

async function configurePlivoNumber(phoneNumber: string, agentId: string) {
  const c = config();
  const body = {
    answer_url: c.appUrl + "/api/voice/plivo/answer?agentId=" + encodeURIComponent(agentId),
    answer_method: "POST",
    hangup_url: c.appUrl + "/api/voice/plivo/status?agentId=" + encodeURIComponent(agentId),
    hangup_method: "POST",
  };
  await requestPlivo("/Number/" + encodeURIComponent(phoneNumber) + "/", { method: "POST", body: JSON.stringify(body) });
}

export async function purchasePlivoNumberForAgent(params: { ownerId: string; agentId: string; phoneNumber: string }) {
  if (!isValidE164(params.phoneNumber)) throw new Error("Phone number must use E.164 format.");
  const price = priceMinor();
  const reference = "phone-number-plivo-" + params.agentId + "-" + params.phoneNumber;
  await reserveFunds({ userId: params.ownerId, amountMinor: price, reference, metadata: { product: "gen3ia_phone_number", provider: "plivo", agentId: params.agentId, phoneNumber: params.phoneNumber } });
  let purchased = false;
  try {
    await requestPlivo("/PhoneNumber/" + encodeURIComponent(params.phoneNumber) + "/", { method: "POST", body: JSON.stringify({}) });
    purchased = true;
    await configurePlivoNumber(params.phoneNumber, params.agentId);
    const doc = adminDb.collection(COLLECTION).doc();
    const now = Date.now();
    const record = {
      id: doc.id, ownerId: params.ownerId, agentId: params.agentId, phoneNumber: params.phoneNumber,
      twilioSid: params.phoneNumber, provider: "plivo" as const, source: "gen3ia" as const, status: "active" as const,
      createdAt: now, updatedAt: now,
    };
    await doc.set(record);
    await settleReservation({ userId: params.ownerId, reference, reservedMinor: price, actualChargeMinor: price, metadata: { product: "gen3ia_phone_number", provider: "plivo", agentId: params.agentId, phoneNumber: params.phoneNumber } });
    return { ...record, priceMinor: price };
  } catch (error) {
    if (purchased) await requestPlivo("/PhoneNumber/" + encodeURIComponent(params.phoneNumber) + "/", { method: "DELETE" }).catch(() => undefined);
    await releaseReservation({ userId: params.ownerId, reference, reservedMinor: price }).catch(() => undefined);
    throw error;
  }
}

export async function releasePlivoNumber(ownerId: string, id: string) {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Phone number not found.");
  const record = snap.data() as { ownerId: string; provider?: string; phoneNumber: string };
  if (record.ownerId !== ownerId || record.provider !== "plivo") throw new Error("Phone number not found.");
  await requestPlivo("/PhoneNumber/" + encodeURIComponent(record.phoneNumber) + "/", { method: "DELETE" });
  await ref.update({ status: "released", updatedAt: Date.now() });
}
