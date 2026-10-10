import "server-only";

/**
 * MIGRATION R2 TOTALE — moteur r2fs (sérialisation).
 *
 * Firestore est remplacé par des documents JSON dans R2 (`fs/{collection}/{docId}.json`).
 * Ce module porte la correspondance de TYPES Firestore ↔ JSON :
 *   - Timestamp (firebase-admin) ↔ { __fs_ts__: millisecondes } dans R2 ;
 *   - sentinelles FieldValue (increment/delete/serverTimestamp/arrayUnion/
 *     arrayRemove) ↔ marqueurs dédiés, résolus à l'ÉCRITURE (jamais stockés) ;
 *   - valeurs simples (string/number/boolean/null/array/object) identités.
 *
 * La sérialisation d'ÉCRITURE transforme Timestamp et vérifie l'absence de
 * sentinelles résiduelles ; l'HYDRATATION de LECTURE reconstruit les
 * Timestamps. Les undefined sont ignorés (ignoreUndefinedProperties: true
 * était le réglage Firestore du projet — sémantique conservée).
 */

/* ------------------------------------------------------------------ */
/* Timestamp — compatible avec la surface firebase-admin utilisée      */
/* ------------------------------------------------------------------ */

/** Marqueur de sérialisation d'un timestamp (forme stockée dans R2). */
export interface SerializedTimestamp {
  __fs_ts__: number;
}

function estSerializedTimestamp(v: unknown): v is SerializedTimestamp {
  return (
    typeof v === "object" &&
    v !== null &&
    "__fs_ts__" in v &&
    typeof (v as SerializedTimestamp).__fs_ts__ === "number" &&
    Object.keys(v as Record<string, unknown>).length === 1
  );
}

/**
 * FORME LEGACY « {millis: N} » (guérison lecture, audit 10-10).
 *
 * Des documents écrits pendant le churn de déploiement du 9-10 oct. portent
 * leurs timestamps sous la forme brute {"millis": N} (FsTimestamp sérialisé
 * hors versStockage). À la relecture, depuisStockage ne reconnaissait PAS
 * cette forme : le champ restait un objet nu et tout appel
 * `.toMillis()` levait « d.createdAt.toMillis is not a function » (captures
 * production 07:24). La lecture GUÉRIT désormais cette forme — jamais
 * écrite par le moteur courant, toujours réécrite au prochain PUT du doc.
 *
 * Garde : EXACTEMENT une clé `millis` de type number fini — un objet métier
 * homonyme avec d'autres champs n'est JAMAIS transformé.
 */
function estLegacyTimestampMillis(v: unknown): v is { millis: number } {
  if (typeof v !== "object" || v === null) return false;
  const cles = Object.keys(v as Record<string, unknown>);
  if (cles.length !== 1 || cles[0] !== "millis") return false;
  const millis = (v as { millis?: unknown }).millis;
  return typeof millis === "number" && Number.isFinite(millis);
}

/**
 * Timestamp Firestore-like : la surface réellement consommée par le projet
 * (now, fromMillis, fromDate, toMillis, toDate) + seconds/nanoseconds pour
 * compatibilité structurelle. L'égalité compare les millisecondes.
 */
export class FsTimestamp {
  readonly millis: number;

  constructor(millis: number) {
    if (!Number.isFinite(millis)) {
      throw new Error(`FsTimestamp: millisecondes invalides (${millis}).`);
    }
    this.millis = Math.floor(millis);
  }

  static now(): FsTimestamp {
    return new FsTimestamp(Date.now());
  }

  static fromMillis(millis: number): FsTimestamp {
    return new FsTimestamp(millis);
  }

  static fromDate(date: Date): FsTimestamp {
    return new FsTimestamp(date.getTime());
  }

  get seconds(): number {
    return Math.floor(this.millis / 1000);
  }

  get nanoseconds(): number {
    return (this.millis % 1000) * 1_000_000;
  }

  toMillis(): number {
    return this.millis;
  }

  toDate(): Date {
    return new Date(this.millis);
  }

  isEqual(other: FsTimestamp): boolean {
    return other instanceof FsTimestamp && other.millis === this.millis;
  }

  valueOf(): string {
    return String(this.millis).padStart(13, "0");
  }
}

/* ------------------------------------------------------------------ */
/* Sentinelles FieldValue — marqueurs jamais persistés                 */
/* ------------------------------------------------------------------ */

export type SentinelKind =
  | { __fs_sentinel__: "increment"; operand: number }
  | { __fs_sentinel__: "delete" }
  | { __fs_sentinel__: "serverTimestamp" }
  | { __fs_sentinel__: "arrayUnion"; values: unknown[] }
  | { __fs_sentinel__: "arrayRemove"; values: unknown[] };

export function isSentinel(v: unknown): v is SentinelKind {
  return (
    typeof v === "object" &&
    v !== null &&
    "__fs_sentinel__" in v &&
    typeof (v as { __fs_sentinel__?: unknown }).__fs_sentinel__ === "string"
  );
}

export function isDeleteSentinel(v: unknown): boolean {
  return isSentinel(v) && v.__fs_sentinel__ === "delete";
}

export function isServerTimestampSentinel(v: unknown): boolean {
  return isSentinel(v) && v.__fs_sentinel__ === "serverTimestamp";
}

export function isIncrementSentinel(v: unknown): v is Extract<SentinelKind, { __fs_sentinel__: "increment" }> {
  return isSentinel(v) && v.__fs_sentinel__ === "increment";
}

export function isArrayUnionSentinel(v: unknown): v is Extract<SentinelKind, { __fs_sentinel__: "arrayUnion" }> {
  return isSentinel(v) && v.__fs_sentinel__ === "arrayUnion";
}

export function isArrayRemoveSentinel(v: unknown): v is Extract<SentinelKind, { __fs_sentinel__: "arrayRemove" }> {
  return isSentinel(v) && v.__fs_sentinel__ === "arrayRemove";
}

/* ------------------------------------------------------------------ */
/* Transformation d'écriture (avant JSON.stringify)                    */
/* ------------------------------------------------------------------ */

/**
 * Transforme récursivement une valeur pour le stockage : Timestamp →
 * {__fs_ts__}. Les sentinelles ne doivent PLUS être présentes à ce stade
 * (résolues avant) — une sentinelle résiduelle est une erreur de
 * programmation du moteur et lève (jamais stockée silencieusement).
 * undefined ignoré dans les objets (sémantique ignoreUndefinedProperties).
 */
export function versStockage(valeur: unknown): unknown {
  if (valeur === undefined) return undefined; // filtré par l'appelant (objets)
  if (valeur === null || typeof valeur !== "object") return valeur;
  if (valeur instanceof FsTimestamp) return { __fs_ts__: valeur.millis } satisfies SerializedTimestamp;
  if (valeur instanceof Date) return { __fs_ts__: valeur.getTime() } satisfies SerializedTimestamp;
  // Duck-typing Timestamp-like (audit 10-10) : une valeur portant un champ
  // `millis` numérique UNIQUE est un Timestamp d'une autre copie de module
  // (bundle serverless distinct, dual-package) — instanceof échouerait et
  // l'objet serait sérialisé BRUT ({"millis": N}), illisible au retour
  // (« toMillis is not a function »). Sérialisation canonique imposée.
  if (estLegacyTimestampMillis(valeur)) return { __fs_ts__: valeur.millis } satisfies SerializedTimestamp;
  if (isSentinel(valeur)) {
    throw new Error(
      `r2fs: sentinelle FieldValue(${(valeur as SentinelKind).__fs_sentinel__}) non résolue avant l'écriture — bug du moteur.`,
    );
  }
  if (Array.isArray(valeur)) {
    return valeur
      .filter((v) => v !== undefined)
      .map((v) => {
        const t = versStockage(v);
        return t === undefined ? null : t;
      });
  }
  const sortie: Record<string, unknown> = {};
  for (const [cle, v] of Object.entries(valeur as Record<string, unknown>)) {
    if (v === undefined) continue; // ignoreUndefinedProperties
    sortie[cle] = versStockage(v);
  }
  return sortie;
}

/* ------------------------------------------------------------------ */
/* Hydratation de lecture                                              */
/* ------------------------------------------------------------------ */

/** Reconstruit les Timestamps depuis la forme stockée (récursif, retourne une copie). */
export function depuisStockage(valeur: unknown): unknown {
  if (valeur === null || typeof valeur !== "object") return valeur;
  if (estSerializedTimestamp(valeur)) return new FsTimestamp(valeur.__fs_ts__);
  // Guérison LEGACY (audit 10-10) : la forme brute {"millis": N} est
  // reconstruite en FsTimestamp — les documents écrits par les déploiements
  // du churn 9-10 oct. redeviennent lisibles SANS migration préalable.
  if (estLegacyTimestampMillis(valeur)) return new FsTimestamp(valeur.millis);
  if (Array.isArray(valeur)) return valeur.map((v) => depuisStockage(v));
  const sortie: Record<string, unknown> = {};
  for (const [cle, v] of Object.entries(valeur as Record<string, unknown>)) {
    sortie[cle] = depuisStockage(v);
  }
  return sortie;
}

/* ------------------------------------------------------------------ */
/* Comparaison Firestore-like (tri + filtres)                          */
/* ------------------------------------------------------------------ */

/** Rang de type — ordre total Firestore simplifié : null < bool < number < ts < string < array < object. */
function rangType(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (v instanceof FsTimestamp) return 3;
  if (typeof v === "string") return 4;
  if (Array.isArray(v)) return 5;
  return 6;
}

/** Normalise pour comparaison : Date → FsTimestamp. */
export function comparable(v: unknown): unknown {
  return v instanceof Date ? new FsTimestamp(v.getTime()) : v;
}

/** Comparateur total Firestore simplifié (retourne -1/0/1). */
export function compareValeurs(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  const rx = rangType(x);
  const ry = rangType(y);
  if (rx !== ry) return rx < ry ? -1 : 1;
  switch (rx) {
    case 0:
      return 0;
    case 1:
      return x === y ? 0 : x ? 1 : -1;
    case 2:
      return (x as number) - (y as number) || 0;
    case 3:
      return (x as FsTimestamp).millis - (y as FsTimestamp).millis;
    case 4:
      return x === y ? 0 : (x as string) < (y as string) ? -1 : 1;
    case 5: {
      const ax = x as unknown[];
      const ay = y as unknown[];
      for (let i = 0; i < Math.min(ax.length, ay.length); i += 1) {
        const c = compareValeurs(ax[i], ay[i]);
        if (c !== 0) return c;
      }
      return ax.length - ay.length;
    }
    default: {
      const sx = JSON.stringify(versStockage(x));
      const sy = JSON.stringify(versStockage(y));
      return sx === sy ? 0 : sx < sy ? -1 : 1;
    }
  }
}
