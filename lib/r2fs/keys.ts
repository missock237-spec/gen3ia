import "server-only";

/**
 * MIGRATION R2 TOTALE — moteur r2fs (clés).
 *
 * Mapping 1:1 Firestore → R2 :
 *   collection racine `missionQueue` + doc `runId` → `fs/missionQueue/{runId}.json`
 *   sous-collection `organizations/{org}/members/{member}`      →
 *     `fs/organizations/{org}/members/{member}.json`
 *
 * Les identifiants de document Firestore acceptent presque tout sauf « / » ;
 * les segments de clé R2 du projet n'acceptent que [A-Za-z0-9._-]. Tout
 * segment NON conforme est encodé (encodeURIComponent, formes !'()*~
 * normalisées en %XX) — décodage à la lecture (id = decodeSeg(seg)).
 * Collision théorique : un id littéral « a%2Fb » et un id « a/b » produisent
 * la même clé — acceptée (ids du projet : ULID / uid / slug techniques).
 */

const SEGMENT_SON = /^[A-Za-z0-9._-]{1,512}$/;

/** Encode un segment de chemin (collection OU id de doc) en clé R2 sûre. */
export function encodeSeg(segment: string): string {
  if (typeof segment !== "string" || segment.length === 0 || segment.length > 1500) {
    throw new Error(`r2fs: segment de chemin invalide (${JSON.stringify(String(segment)).slice(0, 60)})`);
  }
  if (SEGMENT_SON.test(segment) && segment !== "." && segment !== "..") return segment;
  return encodeURIComponent(segment).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Décode un segment de clé R2 en identifiant de document. */
export function decodeSeg(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Préfixe racine de TOUTES les données Firestore-migrées dans le bucket. */
export const FS_ROOT = "fs/";

/** Clé d'un document : `fs/{chemin collection}/{docId}.json`. */
export function docKey(collectionPath: string[], docId: string): string {
  const chemin = [...collectionPath, encodeSeg(docId)].map(encodeSeg).join("/");
  return `${FS_ROOT}${chemin}.json`;
}

/** Préfixe de listing d'une collection (TOUJOURS terminé par « / »). Racine → « fs/ ». */
export function collectionPrefix(collectionPath: string[]): string {
  if (collectionPath.length === 0) return FS_ROOT;
  const chemin = collectionPath.map(encodeSeg).join("/");
  return `${FS_ROOT}${chemin}/`;
}

/**
 * Parse une clé `fs/...json` en segments décodés (sans l'extension).
 * Retourne null si la clé n'appartient PAS au magasin r2fs.
 */
export function parseKey(key: string): string[] | null {
  if (!key.startsWith(FS_ROOT) || !key.endsWith(".json")) return null;
  const chemin = key.slice(FS_ROOT.length, -".json".length);
  if (chemin.length === 0) return null;
  return chemin.split("/").map(decodeSeg);
}
