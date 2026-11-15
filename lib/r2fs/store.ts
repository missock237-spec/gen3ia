import "server-only";

import {
  deleteObject,
  deleteObjectConditional,
  getObjectWithEtag,
  isR2PreconditionFailed,
  listObjectsUnderPrefix,
  putObjectConditional,
} from "@/lib/storage/r2";

import { collectionPrefix, docKey, parseKey } from "./keys";
import { versStockage, depuisStockage } from "./serialization";

/**
 * MIGRATION R2 TOTALE — moteur r2fs (store bas niveau).
 *
 * Un document = UN objet JSON dans R2. Atomicité par document via les
 * écritures conditionnelles S3 (If-Match ETag / If-None-Match « * ») :
 *   - GET   → { data, etag } | null (absent) ;
 *   - CAS   → PUT If-Match=etag (remplace si inchangé) | PUT If-None-Match=* (crée si absent) ;
 *   - 412   → conflit de concurrence, le caller (transaction/boucle) retente.
 *
 * Erreurs R2 (pannes réseau/5xx) propagent telles quelles : la couche
 * résiliente existante (lib/db/firestore-resilient + quota-guard) les
 * classifie via isFirestoreTransientError (UNAVAILABLE) et applique les
 * deadlines anti-stall — aucun nouveau mécanisme d'erreur parallèle.
 */

/** Plafond d'ÉCRITURE d'un document r2fs (900 Ko — Firestore admettait 1 Mo). */
export const FS_DOC_WRITE_CAP_BYTES = 900 * 1024;

/** Plafond de LECTURE d'un document r2fs (2×, marge). */
export const FS_DOC_READ_CAP_BYTES = FS_DOC_WRITE_CAP_BYTES * 2;

/** Erreur métier du magasin (code gRPC-like pour compatibilité des appelants). */
export class FsError extends Error {
  readonly code: "not_found" | "already_exists" | "failed_precondition" | "invalid_argument" | "unavailable" | "conflict";

  constructor(code: FsError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FsError";
    this.code = code;
  }
}

/** Snapshot brut d'un document lu (données HYDRATÉES + etag). */
export interface RawDocSnapshot {
  exists: boolean;
  /** Données hydratées (Timestamps reconstruits), null si absent. */
  data: Record<string, unknown> | null;
  /** ETag R2 de l'objet lu ("" si absent). */
  etag: string;
  /** true si le snapshot vient d'une lecture RÉELLE (pas d'un cache de tx). */
  fresh: boolean;
}

export const SNAPSHOT_ABSENT: RawDocSnapshot = { exists: false, data: null, etag: "", fresh: false };

/** Lit un document (absent → snapshot.exists=false, jamais d'exception). */
export async function rawGet(collectionPath: string[], docId: string): Promise<RawDocSnapshot> {
  const key = docKey(collectionPath, docId);
  let lu: Awaited<ReturnType<typeof getObjectWithEtag>>;
  try {
    lu = await getObjectWithEtag(key, FS_DOC_READ_CAP_BYTES);
  } catch (error) {
    throw new FsError("unavailable", `r2fs: lecture impossible (${key})`, { cause: error });
  }
  if (lu === null) return SNAPSHOT_ABSENT;
  let parse: unknown;
  try {
    parse = JSON.parse(lu.data.toString("utf8"));
  } catch (error) {
    throw new FsError("failed_precondition", `r2fs: document JSON illisible (${key})`, { cause: error });
  }
  if (parse === null || typeof parse !== "object" || Array.isArray(parse)) {
    throw new FsError("failed_precondition", `r2fs: document non-objet (${key})`);
  }
  return {
    exists: true,
    data: depuisStockage(parse) as Record<string, unknown>,
    etag: lu.etag,
    fresh: true,
  };
}

/**
 * Écrit un document : CAS si `etag` fourni (If-Match) ou `createOnly` (If-
 * None-Match « * »), écriture inconditionnelle sinon. Retourne le snapshot
 * post-écriture (etag nouveau). Précondition échouée → FsError("conflict").
 */
export async function rawPut(
  collectionPath: string[],
  docId: string,
  data: Record<string, unknown>,
  opts?: { etag?: string; createOnly?: boolean },
): Promise<RawDocSnapshot> {
  const key = docKey(collectionPath, docId);
  const body = Buffer.from(JSON.stringify(versStockage(data)), "utf8");
  if (body.byteLength > FS_DOC_WRITE_CAP_BYTES) {
    throw new FsError(
      "invalid_argument",
      `r2fs: document trop grand (${body.byteLength} octets > ${FS_DOC_WRITE_CAP_BYTES}) : ${key}`,
    );
  }
  const resultat = await putObjectConditional(
    key,
    body,
    "application/json",
    opts?.createOnly ? { ifNoneMatch: "*" } : opts?.etag ? { ifMatch: opts.etag } : undefined,
  );
  if (resultat === null) {
    throw new FsError("conflict", `r2fs: écriture conditionnelle perdue (412) : ${key}`);
  }
  return { exists: true, data, etag: resultat.etag, fresh: false };
}

/** Supprime un document : CAS si etag fourni, inconditionnel sinon. true si supprimé. */
export async function rawDelete(collectionPath: string[], docId: string, opts?: { etag?: string }): Promise<boolean> {
  const key = docKey(collectionPath, docId);
  try {
    if (opts?.etag) {
      return await deleteObjectConditional(key, opts.etag);
    }
    await deleteObject(key);
    return true;
  } catch (error) {
    throw new FsError("unavailable", `r2fs: suppression impossible (${key})`, { cause: error });
  }
}

/** Listing brut des clés d'une collection (cap par défaut 2000 objets). */
export async function rawListKeys(
  collectionPath: string[],
  opts?: { maxResults?: number },
): Promise<Array<{ key: string; docId: string }>> {
  const prefix = collectionPrefix(collectionPath);
  let objets: Awaited<ReturnType<typeof listObjectsUnderPrefix>>;
  try {
    objets = await listObjectsUnderPrefix(prefix, opts?.maxResults ?? 2000);
  } catch (error) {
    throw new FsError("unavailable", `r2fs: listing impossible (${prefix})`, { cause: error });
  }
  const sortie: Array<{ key: string; docId: string }> = [];
  const racine = collectionPath.length === 0;
  for (const objet of objets) {
    const segments = parseKey(objet.key);
    if (!segments) continue;
    // Racine (listing fs/ entier, pour collectionGroup) : TOUTES profondeurs.
    // Sinon : uniquement les documents DIRECTEMENT dans la collection (pas
    // les sous-collections) — fs/coll/{id}.json → 2 segments après le parse.
    if (racine) {
      if (segments.length < 2) continue;
      sortie.push({ key: objet.key, docId: segments[segments.length - 1] });
      continue;
    }
    if (segments.length !== collectionPath.length + 1) continue;
    sortie.push({ key: objet.key, docId: segments[segments.length - 1] });
  }
  return sortie;
}

/** Expose le classifieur 412 (tests + transaction). */
export { isR2PreconditionFailed };

/** Vrai si l'erreur est un conflit CAS (réessayable). */
export function isConflictError(error: unknown): boolean {
  return error instanceof FsError && error.code === "conflict";
}
