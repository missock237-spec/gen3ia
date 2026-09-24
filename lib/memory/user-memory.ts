import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { assertSafeMemoryValue } from "./keyvalue";

const COLLECTION = "userMemories";
const MAX_ENTRIES = 200;

function ref(userId: string, key: string) { return adminDb.collection(COLLECTION).doc(`${userId}_${encodeURIComponent(key)}`); }

export async function remember(params: { userId: string; key: string; value: unknown; source?: "user" | "agent"; }): Promise<void> {
  if (!params.userId?.trim()) throw new Error("Memory requires userId.");
  if (!/^[\p{L}\p{N}._:-]{1,160}$/u.test(params.key)) throw new Error("Invalid memory key.");
  const value = assertSafeMemoryValue(params.value);
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

/**
 * Lecture unitaire d'un souvenir clé/valeur (sert au contrat anti-écrasement
 * de POST /api/memory : comparer la valeur entrante à l'existante avant
 * d'autoriser l'écriture). Retourne null si la clé est inconnue.
 */
export async function getMemoryEntry(userId: string, key: string): Promise<{ key: string; value: string; source: string; updatedAt?: string } | null> {
  const snap = await ref(userId, key).get();
  if (!snap.exists) return null;
  const updatedAt = snap.get("updatedAt");
  return {
    key: String(snap.get("key") ?? key),
    value: String(snap.get("value") ?? ""),
    source: String(snap.get("source") ?? "user"),
    updatedAt: typeof updatedAt?.toMillis === "function" ? new Date(updatedAt.toMillis()).toISOString() : undefined,
  };
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
