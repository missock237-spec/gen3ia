import "server-only";

import type { DocumentReference, Firestore, SetOptions } from "@/lib/r2fs";

/**
 * Écritures Firestore par lots — la plateforme refuse tout batch de plus de
 * 500 opérations (crash `INVALID_ARGUMENT` au-delà). Tout traitement
 * potentiellement volumineux (purge de fragments, détachement de
 * conversations, suppression de documents…) passe par ce helper : il découpe
 * les opérations en lots de 450 (marge de sécurité) et les commit
 * séquentiellement, quitte à boucler plusieurs fois.
 *
 * Reprend le pattern de lib/memory/privacy.ts (purge par boucle de lots) et
 * le rend réutilisable. Retourne le nombre total d'opérations commitées.
 */

/** Taille des lots : 450 ops (marge sous la limite Firestore de 500). */
export const CHUNKED_COMMIT_SIZE = 450;

export type ChunkedWriteOp =
  | { kind: "delete"; ref: DocumentReference }
  | { kind: "create"; ref: DocumentReference; data: Record<string, unknown> }
  | { kind: "set"; ref: DocumentReference; data: Record<string, unknown>; options?: SetOptions }
  | { kind: "update"; ref: DocumentReference; data: Record<string, unknown> };

export async function commitOpsInChunks(
  db: Firestore,
  ops: readonly ChunkedWriteOp[],
  chunkSize: number = CHUNKED_COMMIT_SIZE,
): Promise<number> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) {
    throw new Error(`Taille de lot invalide : ${chunkSize} (attendu 1..500).`);
  }
  let committed = 0;
  for (let start = 0; start < ops.length; start += chunkSize) {
    const batch = db.batch();
    for (const op of ops.slice(start, start + chunkSize)) {
      if (op.kind === "delete") batch.delete(op.ref);
      else if (op.kind === "create") batch.create(op.ref, op.data);
      else if (op.kind === "set") {
        if (op.options) batch.set(op.ref, op.data, op.options);
        else batch.set(op.ref, op.data);
      } else batch.update(op.ref, op.data);
    }
    await batch.commit();
    committed += Math.min(chunkSize, ops.length - start);
  }
  return committed;
}
