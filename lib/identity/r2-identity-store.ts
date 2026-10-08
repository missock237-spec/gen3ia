import "server-only";

import {
  deleteFromR2,
  downloadFromR2,
  listObjectsUnderPrefix,
  putObject,
} from "@/lib/storage/r2";

import { IdentitySchema, UID_PATTERN, type Identity } from "./schema";

/**
 * Task 108-b — LA BASE DE DONNÉES D'IDENTITÉS dans Cloudflare R2 (S3
 * compatible, client existant lib/storage/r2.ts réutilisé tel quel).
 *
 * Modèle : UN document JSON par utilisateur, clé canonique
 *   `identities/{uid}.json`
 * L'uid est revalidé par la regex du schéma AVANT toute composition de clé :
 * un uid hostile ("../x", "a/b", vide, 129 chars) est rejeté (IdentityError
 * "invalid") sans jamais être transformé en clé — traversée impossible.
 *
 * Sémantique d'absence : le dépôt ne dispose pas de helper "404" partagé ;
 * GetObject sur une clé absente remonte du SDK S3 v3 avec name/code
 * `NoSuchKey` (+ $metadata.httpStatusCode 404) — les mocks du dépôt
 * (workspace-durability.test.ts) lèvent un Error("NoSuchKey (mock)").
 * `estAbsenceR2` couvre les deux formes (name, code, métadonnées, message).
 *
 * Toute erreur R2 NON-absence est propage brute : c'est le SERVICE qui la
 * traduit en IdentityError("unavailable") (mode dégradé des routes).
 */

export const IDENTITY_KEY_PREFIX = "identities/";
export const IDENTITY_KEY_SUFFIX = ".json";

/** Plafond d'ÉCRITURE du document identité (garde putIdentity). */
export const IDENTITY_MAX_BYTES = 64 * 1024;
/** Plafond de LECTURE passé à downloadFromR2 (2× la garde d'écriture). */
export const IDENTITY_READ_LIMIT_BYTES = 128 * 1024;

/** Fenêtre de scan du listage (audit/RGPD admin — usage futur). */
const LIST_SCAN_MAX_OBJECTS = 1000;

export type IdentityErrorCode =
  | "not_found"
  | "corrupted"
  | "too_large"
  | "unavailable"
  | "invalid";

/** Erreur métier de la base d'identités — le code pilote les statuts HTTP. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IdentityError";
    this.code = code;
  }
}

/** Rejette un uid hostile AVANT toute composition de clé (retourne l'uid sain). */
export function assertValidUid(uid: string): string {
  if (typeof uid !== "string" || !UID_PATTERN.test(uid)) {
    throw new IdentityError("invalid", "Identifiant utilisateur invalide.");
  }
  return uid;
}

/** Clé canonique `identities/{uid}.json` — uid revalidé, aucune autre entrée. */
export function identityKey(uid: string): string {
  return `${IDENTITY_KEY_PREFIX}${assertValidUid(uid)}${IDENTITY_KEY_SUFFIX}`;
}

/** Lecture sûre d'une propriété d'erreur sans `any` (duck-typing SDK). */
function proprieteErreur(error: unknown, cle: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[cle];
}

/**
 * Vrai si l'erreur signale une clé ABSENTE (GetObject 404 / NoSuchKey),
 * quelle que soit la forme (SDK AWS v3 réel ou mocks en mémoire du dépôt).
 */
export function estAbsenceR2(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = proprieteErreur(error, "code") ?? proprieteErreur(error, "Code");
  const statutHttp = proprieteErreur(error, "$metadata") as
    | { httpStatusCode?: unknown }
    | undefined;
  return (
    error.name === "NoSuchKey" ||
    code === "NoSuchKey" ||
    statutHttp?.httpStatusCode === 404 ||
    /NoSuchKey/i.test(error.message)
  );
}

/** Tri récursif des clés — sérialisation canonique, stable et diffable. */
function trierProfond(valeur: unknown): unknown {
  if (Array.isArray(valeur)) return valeur.map(trierProfond);
  if (valeur !== null && typeof valeur === "object") {
    const entrees = Object.entries(valeur as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entrees.map(([cle, v]) => [cle, trierProfond(v)]));
  }
  return valeur;
}

/** Forme canonique du document : objet schéma-écrit, clés triées. */
export function serializeIdentity(identity: Identity): string {
  return JSON.stringify(trierProfond(identity));
}

/**
 * Garde de taille du document identité (64 Ko) — défense en profondeur :
 * les plafonds du schéma rendent le dépassement inaccessible aujourd'hui,
 * mais une évolution du schéma ne doit jamais produire d'objet géant dans
 * la base (un objet identité est lu À CHAQUE session : sa taille est un
 * invariant de performance, pas un détail).
 */
export function assertTailleIdentite(body: Buffer): void {
  if (body.byteLength > IDENTITY_MAX_BYTES) {
    throw new IdentityError(
      "too_large",
      `Identité trop grande (${body.byteLength} octets > ${IDENTITY_MAX_BYTES}).`,
    );
  }
}

/**
 * Écrit (crée OU remplace) le document identité de l'uid.
 * Le document est réécrit PAR LE SCHÉMA avant sérialisation : le stocké
 * est toujours conforme (défauts posés, hors-schéma impossible par ce chemin).
 */
export async function putIdentity(identity: Identity): Promise<void> {
  // uid revalidé AVANT toute composition de clé (rejet d'un uid hostile).
  const key = identityKey(identity.uid);
  const conforme = IdentitySchema.safeParse(identity);
  if (!conforme.success) {
    throw new IdentityError("corrupted", "Identité non conforme au schéma.", { cause: conforme.error });
  }
  const body = Buffer.from(serializeIdentity(conforme.data), "utf8");
  assertTailleIdentite(body);
  await putObject({ key, body, contentType: "application/json", contentLength: body.byteLength });
}

/**
 * Lit l'identité d'un uid. Absente → null (NoSuchKey/404). JSON corrompu ou
 * hors schéma → IdentityError("corrupted") : l'appelant décide (le service
 * recrée lors du provisionnement). Toute autre erreur R2 → propage brute.
 */
export async function getIdentity(uid: string): Promise<Identity | null> {
  const key = identityKey(uid);
  let buffer: Buffer;
  try {
    buffer = await downloadFromR2(key, IDENTITY_READ_LIMIT_BYTES);
  } catch (error) {
    if (estAbsenceR2(error)) return null;
    if (error instanceof Error && /exceeds configured read limit/i.test(error.message)) {
      throw new IdentityError(
        "too_large",
        `Identité trop grande pour la lecture (> ${IDENTITY_READ_LIMIT_BYTES} octets).`,
        { cause: error },
      );
    }
    throw error;
  }

  let brut: unknown;
  try {
    brut = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new IdentityError("corrupted", "Document d'identité illisible (JSON invalide).", { cause: error });
  }
  const parsed = IdentitySchema.safeParse(brut);
  if (!parsed.success) {
    throw new IdentityError("corrupted", "Document d'identité hors schéma.", { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * Supprime le document identité. Idempotent : une clé déjà absente reste
 * un succès (DeleteObject S3 ne renvoie pas 404 ; par prudence une absence
 * remontée est aussi traitée comme succès).
 */
export async function deleteIdentity(uid: string): Promise<void> {
  const key = identityKey(uid);
  try {
    await deleteFromR2(key);
  } catch (error) {
    if (estAbsenceR2(error)) return;
    throw error;
  }
}

export interface ListIdentitiesOptions {
  /** 1..100 (défaut 50). */
  limit?: number;
  /** Curseur opaque = dernier uid de la page précédente. */
  cursor?: string;
}

export interface IdentityPage {
  uids: string[];
  nextCursor?: string;
}

/**
 * Listage paginé des identités (audit / export RGPD admin — usage futur,
 * aucune route admin dans ce lot). Les clés non conformes au format
 * `identities/{uid}.json` (ou à la regex uid) sont ignorées, jamais
 * extraites comme des identités.
 */
export async function listIdentities(options: ListIdentitiesOptions = {}): Promise<IdentityPage> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 100);
  const objets = await listObjectsUnderPrefix(IDENTITY_KEY_PREFIX, LIST_SCAN_MAX_OBJECTS);
  const uids = objets
    .map((objet) => objet.key)
    .filter((key) => key.startsWith(IDENTITY_KEY_PREFIX) && key.endsWith(IDENTITY_KEY_SUFFIX))
    .map((key) => key.slice(IDENTITY_KEY_PREFIX.length, key.length - IDENTITY_KEY_SUFFIX.length))
    .filter((uid) => UID_PATTERN.test(uid))
    .sort();

  let depart = 0;
  if (options.cursor) {
    // Curseur inconnu (données évoluées entre deux pages) : reprise au début.
    const index = uids.indexOf(options.cursor);
    depart = index >= 0 ? index + 1 : 0;
  }
  const page = uids.slice(depart, depart + limit);
  const reste = depart + limit < uids.length;
  return {
    uids: page,
    ...(reste && page.length > 0 ? { nextCursor: page[page.length - 1] } : {}),
  };
}
