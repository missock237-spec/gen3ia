import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

const COLLECTION = "userMemories";
const MAX_VALUE_BYTES = 50_000;
const MAX_ENTRIES = 200;
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{20,}/i, /AIza[0-9A-Za-z_-]{20,}/, /gh[pousr]_[A-Za-z0-9_]{20,}/, /xox[baprs]-[A-Za-z0-9-]{20,}/i, /bearer\s+[A-Za-z0-9._-]{20,}/i, /password\s*[:=]/i, /api[_ -]?key\s*[:=]/i, /secret\s*[:=]/i];

function ref(userId: string, key: string) { return adminDb.collection(COLLECTION).doc(`${userId}_${encodeURIComponent(key)}`); }
function safeText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) throw new Error("Memory value cannot be empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_VALUE_BYTES) throw new Error("Memory value exceeds the allowed size.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new Error("Memory rejected because it appears to contain credentials or secrets.");
  return text;
}

export async function remember(params: { userId: string; key: string; value: unknown; source?: "user" | "agent"; }): Promise<void> {
  if (!params.userId?.trim()) throw new Error("Memory requires userId.");
  if (!/^[\p{L}\p{N}._:-]{1,160}$/u.test(params.key)) throw new Error("Invalid memory key.");
  const value = safeText(params.value);
  const docRef = ref(params.userId, params.key);
  const existing = await docRef.get();
  if (!existing.exists) {
    const current = await adminDb.collection(COLLECTION).where("userId", "==", params.userId).count().get();
    if (current.data().count >= MAX_ENTRIES) throw new Error(`Limite de ${MAX_ENTRIES} souvenirs atteinte. Supprimez-en pour libérer de la place.`);
  }
  await docRef.set({ userId: params.userId, key: params.key, value, source: params.source ?? "user", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export async function recall(params: { userId: string; key: string; }): Promise<string | null> {
  const snap = await ref(params.userId, params.key).get();
  if (!snap.exists) return null;
  return String(snap.get("value") ?? "");
}

export async function listMemories(userId: string, limit = 100) {
  const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(Math.min(Math.max(limit, 1), 200)).get();
  return snap.docs.map((doc) => {
    const updatedAt = doc.get("updatedAt");
    return {
      key: String(doc.get("key")),
      value: String(doc.get("value")),
      source: String(doc.get("source") ?? "user"),
      updatedAt: typeof updatedAt?.toMillis === "function" ? new Date(updatedAt.toMillis()).toISOString() : undefined,
    };
  });
}

export async function forget(userId: string, key: string): Promise<void> { await ref(userId, key).delete(); }
