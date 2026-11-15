import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";

export type AdsProvider = "google_ads" | "meta_ads" | "tiktok_ads";
const COLLECTION = "adsConnections";
const STATE_COLLECTION = "adsOAuthStates";

function key() {
  const raw = process.env.GEN3IA_ADS_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("GEN3IA_ADS_TOKEN_ENCRYPTION_KEY is required for Ads connections.");
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length !== 32) throw new Error("GEN3IA_ADS_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return buffer;
}
function encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`; }
function decrypt(value: string) { const [iv, tag, ciphertext] = value.split("."); if (!iv || !tag || !ciphertext) throw new Error("Invalid encrypted Ads credential."); const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"); }

function client(provider: AdsProvider) {
  const map = {
    google_ads: { id: process.env.GOOGLE_ADS_CLIENT_ID, secret: process.env.GOOGLE_ADS_CLIENT_SECRET, auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/adwords"] },
    meta_ads: { id: process.env.META_ADS_APP_ID, secret: process.env.META_ADS_APP_SECRET, auth: `https://www.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v23.0"}/dialog/oauth`, token: `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v23.0"}/oauth/access_token`, scopes: ["ads_management", "ads_read", "business_management"] },
    tiktok_ads: { id: process.env.TIKTOK_ADS_CLIENT_KEY, secret: process.env.TIKTOK_ADS_CLIENT_SECRET, auth: process.env.TIKTOK_ADS_AUTH_URL ?? "https://business-api.tiktok.com/portal/auth", token: process.env.TIKTOK_ADS_TOKEN_URL ?? "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", scopes: ["user.info.basic", "ad.read", "ad.write"] },
  }[provider];
  if (!map.id || !map.secret) throw new Error(`${provider} OAuth credentials are not configured.`);
  return map;
}

export async function createOAuthState(params: { userId: string; provider: AdsProvider; redirectUri: string }) {
  const state = randomBytes(32).toString("base64url");
  await adminDb.collection(STATE_COLLECTION).doc(state).set({ userId: params.userId, provider: params.provider, redirectUri: params.redirectUri, expiresAtMs: Date.now() + 10 * 60 * 1000, createdAt: FieldValue.serverTimestamp() });
  return state;
}

export async function consumeOAuthState(state: string) {
  const ref = adminDb.collection(STATE_COLLECTION).doc(state);
  return adminDb.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new Error("Invalid OAuth state."); const data = snap.data()!; tx.delete(ref); if (Number(data.expiresAtMs) < Date.now()) throw new Error("OAuth state expired."); return { userId: String(data.userId), provider: data.provider as AdsProvider, redirectUri: String(data.redirectUri) }; });
}

export function buildAuthorizationUrl(provider: AdsProvider, state: string, redirectUri: string) {
  const c = client(provider);
  const params = new URLSearchParams({ client_id: c.id!, redirect_uri: redirectUri, response_type: "code", state });
  if (provider === "tiktok_ads") params.set("scope", c.scopes.join(",")); else params.set("scope", c.scopes.join(" "));
  if (provider === "google_ads") params.set("access_type", "offline");
  if (provider === "google_ads") params.set("prompt", "consent");
  return `${c.auth}?${params.toString()}`;
}

export async function exchangeCode(provider: AdsProvider, code: string, redirectUri: string) {
  const c = client(provider);
  const body = new URLSearchParams({ client_id: c.id!, client_secret: c.secret!, code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  const response = await fetch(c.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json();
  if (!response.ok || typeof data.access_token !== "string") throw new Error(`Unable to connect ${provider}.`);
  return { accessToken: String(data.access_token), refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined, expiresIn: Number(data.expires_in ?? 3600), accountId: typeof data.account_id === "string" ? data.account_id : undefined };
}

export async function saveConnection(params: { userId: string; provider: AdsProvider; accessToken: string; refreshToken?: string; expiresIn: number; accountId?: string }) {
  await adminDb.collection(COLLECTION).doc(`${params.userId}_${params.provider}`).set({ userId: params.userId, provider: params.provider, accessToken: encrypt(params.accessToken), refreshToken: params.refreshToken ? encrypt(params.refreshToken) : null, expiresAtMs: Date.now() + Math.max(60, params.expiresIn - 60) * 1000, accountId: params.accountId ?? null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export async function getConnection(userId: string, provider: AdsProvider) {
  const snap = await adminDb.collection(COLLECTION).doc(`${userId}_${provider}`).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return { provider, accountId: data.accountId ? String(data.accountId) : undefined, accessToken: decrypt(String(data.accessToken)), refreshToken: data.refreshToken ? decrypt(String(data.refreshToken)) : undefined, expiresAtMs: Number(data.expiresAtMs ?? 0) };
}

export async function listConnections(userId: string) { const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).get(); return snap.docs.map((d) => ({ provider: String(d.get("provider")), accountId: d.get("accountId") ? String(d.get("accountId")) : undefined, expiresAtMs: Number(d.get("expiresAtMs") ?? 0) })); }
