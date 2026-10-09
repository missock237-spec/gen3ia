import { FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";

const COLLECTION = "executionIdempotency";
const MAX_RESULT_CHARS = 200_000;
type State = "processing" | "completed" | "failed";

/**
 * Fenêtre de staleness : si le process meurt entre le claim et le
 * complete/fail, le doc resterait `state:"processing"` pour toujours —
 * l'action ne serait plus rejouable (QStash redélivre, tout bloc). Au-delà
 * de 10 min, un claim `processing` est considéré mort et re-claimable.
 * Pattern : PUBLISH_RESERVATION_MS (lib/queue/dispatch-loop.ts).
 */
export const CLAIMS_PROCESSING_MS = 10 * 60 * 1000;

/**
 * Durée de vie du doc via le champ `expireAt` (policy TTL Firestore à
 * activer côté projet : gcloud firestore fields ttl update). Sans lui la
 * collection croît à l'infini. Rafraîchi au claim et à la finalisation :
 * un résultat `completed` reste rejouable ~30 j avant purge.
 */
export const CLAIMS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IdempotencyClaim { key: string; state: State; result?: unknown; error?: string; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}
function docId(userId: string, toolName: string, key: string): string { return digest(stableSerialize({ userId, toolName, key })).slice(0, 64); }

/**
 * GARDE QUOTA (Task 110-e) : le claim transactionnel est AWAITÉ par
 * executeToolSecurely AVANT chaque outil à risque external/destructive —
 * sur Firestore brut, sous quota quotidien épuisé la transaction pendaît
 * SANS lever (Task 97) et l'étape outil pendait jusqu'à son timeout (120 s
 * par défaut). completeExecutionIdempotency est aussi awaité sans catch
 * après une exécution RÉUSSIE : sans garde, le succès était retenu par une
 * écriture pendante. runFirestoreGuarded borne chaque touche à 6 s +
 * disjoncteur ; la sémantique métier (claim exactement-une-fois, rejet des
 * doublons vivants) est inchangée.
 */

/** Millis de `updatedAt` (Timestamp Firestore ou nombre) ; null si illisible. */
function updatedAtMs(data: Record<string, unknown>): number | null {
  const value = data.updatedAt;
  if (value && typeof value === "object" && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (typeof value === "number") return value;
  return null;
}

/** Un claim `processing` plus vieux que la fenêtre est un process mort. */
function isProcessingClaimStale(data: Record<string, unknown>, nowMs: number): boolean {
  const updated = updatedAtMs(data);
  // Horodatage illisible (doc corrompu) : prudent, on ne rejoue pas.
  if (updated === null) return false;
  return nowMs - updated >= CLAIMS_PROCESSING_MS;
}

export async function claimExecutionIdempotency(params: { userId: string; toolName: string; key: string; input: Record<string, unknown> }): Promise<IdempotencyClaim> {
  if (!params.userId.trim() || !params.toolName.trim() || !params.key.trim()) throw new Error("Invalid idempotency parameters.");
  const id = docId(params.userId, params.toolName, params.key);
  const inputHash = digest(stableSerialize(params.input));
  const ref = adminDb.collection(COLLECTION).doc(id);
  const expireAt = new Date(Date.now() + CLAIMS_TTL_MS);
  return runFirestoreGuarded(`idempotency claim ${params.toolName}`, () => adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() ?? {};
      if (String(data.inputHash ?? "") !== inputHash) throw new Error("Idempotency key conflict: arguments differ.");
      const state = String(data.state) as State;
      if (state === "completed") return { key: id, state, result: data.result };
      if (state === "failed") return { key: id, state, error: String(data.error ?? "Execution previously failed.") };
      // state === "processing" : bail expiré (process tué en cours
      // d'exécution) → re-claim avec un nouveau bail, l'action externe n'a
      // PAS été confirmée et doit être rejouée. Sinon doublon vivant bloqué.
      if (isProcessingClaimStale(data, Date.now())) {
        tx.set(ref, {
          userId: params.userId,
          toolName: params.toolName,
          key: params.key,
          inputHash,
          state: "processing",
          createdAt: data.createdAt ?? FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          claimCount: Number(data.claimCount ?? 0) + 1,
          expireAt,
        });
        return { key: id, state: "processing" };
      }
      throw new Error("Identical action is already processing; duplicate execution is blocked.");
    }
    tx.create(ref, { userId: params.userId, toolName: params.toolName, key: params.key, inputHash, state: "processing", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), claimCount: 1, expireAt });
    return { key: id, state: "processing" };
  }));
}
export async function completeExecutionIdempotency(params: { key: string; result: unknown }): Promise<void> {
  if (stableSerialize(params.result).length > MAX_RESULT_CHARS) throw new Error("Idempotency result exceeds persistence limit.");
  await runFirestoreGuarded(`idempotency complete ${params.key.slice(0, 16)}`, () => adminDb.collection(COLLECTION).doc(params.key).update({ state: "completed", result: params.result, updatedAt: FieldValue.serverTimestamp(), expireAt: new Date(Date.now() + CLAIMS_TTL_MS) }));
}
export async function failExecutionIdempotency(params: { key: string; error: string }): Promise<void> {
  await runFirestoreGuarded(`idempotency fail ${params.key.slice(0, 16)}`, () => adminDb.collection(COLLECTION).doc(params.key).update({ state: "failed", error: params.error.slice(0, 4_000), updatedAt: FieldValue.serverTimestamp(), expireAt: new Date(Date.now() + CLAIMS_TTL_MS) }));
}
