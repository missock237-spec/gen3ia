import "server-only";

import { webcrypto } from "node:crypto";

import {
  deleteObject,
  downloadFromR2,
  listObjectsUnderPrefix,
  putObject,
} from "@/lib/storage/r2";
import { assertValidUid, estAbsenceR2 } from "@/lib/identity/r2-identity-store";

/**
 * Task 109-a — COUCHE FONDATION du plan de données UTILISATEUR sur R2
 * (S3 compatible, client existant lib/storage/r2.ts réutilisé tel quel).
 *
 * Modèle : UN document JSON par objet, clés canoniques sous `users/{uid}/...`
 * (conversations, messages, mémoire, agents, runs — voir le contrat lot 109-0
 * dans worklog.md). Les lots suivants (109-b/c/d) composent leurs clés via
 * userDir/userKey, génèrent leurs identifiants via newUlid, et lisent/écrivent
 * via readJson/readJsonIfExists/writeJson/patchJson ; removePrefix sert aux
 * purges RGPD, listKeys/listJson aux scans par préfixe.
 *
 * Sécurité : l'uid est revalidé AVANT toute composition de clé (assertValidUid
 * importé de lib/identity/r2-identity-store — jamais dupliqué) et chaque
 * segment est validé par une regex stricte : un uid ou un segment hostile ne
 * produit JAMAIS de clé — traversée d'espace de clés impossible.
 *
 * Sémantique d'absence : estAbsenceR2 (même source) reconnaît NoSuchKey / 404
 * sous toutes ses formes (SDK S3 v3 réel comme mocks en mémoire du dépôt).
 *
 * Erreurs : tout échec est un UserDataError codé —
 *   not_found (absence) · too_large (plafonds dépassés) · corrupted (JSON
 *   illisible) · unavailable (panne R2) · invalid (uid/segment/plafond invalide).
 *
 * Sérialisation : CANONIQUE (tri récursif des clés, même algorithme que
 * identity-store) — documents stables et diffables, indépendants de l'ordre
 * d'insertion des champs.
 */

/* ------------------------------------------------------------------ */
/* Erreur métier                                                       */
/* ------------------------------------------------------------------ */

/**
 * Erreur métier du magasin utilisateur — le code pilote le traitement par
 * les appelants (statut HTTP, mode dégradé, recréation de document).
 */
export class UserDataError extends Error {
  readonly code: "not_found" | "too_large" | "corrupted" | "unavailable" | "invalid";

  constructor(code: UserDataError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UserDataError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Plafonds de taille (défense en profondeur, même philosophie que     */
/* identity-store : la taille d'un doc lu souvent est un invariant)    */
/* ------------------------------------------------------------------ */

/** Plafond d'ÉCRITURE par défaut d'un document utilisateur (256 Ko). */
export const USER_DATA_DEFAULT_WRITE_CAP_BYTES = 256 * 1024;

/** Plafond de LECTURE associé à un plafond d'écriture donné (2×, marge de sécurité). */
export function readCapFor(writeCap: number): number {
  return writeCap * 2;
}

/** Plafond de lecture par défaut (2× le plafond d'écriture par défaut). */
const USER_DATA_DEFAULT_READ_CAP_BYTES = readCapFor(USER_DATA_DEFAULT_WRITE_CAP_BYTES);

/* ------------------------------------------------------------------ */
/* Composition de clés — uid et segments revalidés, traversée impossible */
/* ------------------------------------------------------------------ */

/**
 * Segments de clé : A-Z a-z 0-9 . _ - et séquences d'échappement `%XX`
 * (sortie canonique d'encodeURIComponent — ex. segment mémoire
 * `projet%3Aalpha`), 1..512 caractères. Au-delà du raisonnable, la couche
 * mémoire hache le segment (R2 limite une clé objet à 1024 octets).
 */
const SEGMENT_PATTERN = /^(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){1,512}$/;

/**
 * Rejette un segment hostile AVANT toute composition de clé. "." et ".."
 * matchent la regex mais sont explicitement interdits : aucune traversée.
 */
function assertValidSegment(segment: string): string {
  if (
    typeof segment !== "string" ||
    !SEGMENT_PATTERN.test(segment) ||
    segment === "." ||
    segment === ".."
  ) {
    throw new UserDataError(
      "invalid",
      `Segment de clé utilisateur invalide (${JSON.stringify(segment)}) : ` +
        "caractères autorisés A-Z a-z 0-9 . _ - et séquences %XX (1..512), \".\" et \"..\" interdits.",
    );
  }
  return segment;
}

/**
 * Revalide l'uid via assertValidUid (logique identity-store réutilisée, pas
 * dupliquée) et traduit le rejet en UserDataError("invalid") : la surface
 * d'erreur de CE magasin est homogène pour les appelants.
 */
function revalideUid(uid: string): string {
  try {
    return assertValidUid(uid);
  } catch (error) {
    throw new UserDataError("invalid", "Identifiant utilisateur invalide.", { cause: error });
  }
}

/**
 * Répertoire utilisateur : `users/{uid}/{segments.join("/")}`. L'uid est
 * revalidé et chaque segment est validé — un uid/segment hostile lève
 * UserDataError("invalid") sans jamais produire de clé. Sans segment, la
 * forme canonique `users/{uid}/` reste utilisable comme PRÉFIXE de scan.
 */
export function userDir(uid: string, ...segments: string[]): string {
  const uidSain = revalideUid(uid);
  const segmentsValides = segments.map(assertValidSegment);
  return `users/${uidSain}/${segmentsValides.join("/")}`;
}

/**
 * Clé de document JSON : userDir + suffixe `.json` sur le dernier segment
 * (sans double suffixe s'il est déjà présent). Exige au moins un segment :
 * `users/{uid}.json` ne fait pas partie du schéma de clés du magasin.
 */
export function userKey(uid: string, ...segments: string[]): string {
  if (segments.length === 0) {
    throw new UserDataError(
      "invalid",
      "userKey exige au moins un segment de document après l'uid.",
    );
  }
  const dir = userDir(uid, ...segments);
  return dir.endsWith(".json") ? dir : `${dir}.json`;
}

/* ------------------------------------------------------------------ */
/* ULID — identifiants triables chronologiquement, sans dépendance     */
/* ------------------------------------------------------------------ */

/** Alphabet Crockford base32 (sans I, L, O, U) — ordre ASCII = ordre numérique. */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface SourceAleatoire {
  getRandomValues<T extends ArrayBufferView>(tableau: T): T;
}

/** WebCrypto global quand il existe (Node ≥ 19, edge), repli node:crypto sinon. */
function moteurAlea(): SourceAleatoire {
  const globalCrypto = (globalThis as { crypto?: SourceAleatoire }).crypto;
  return globalCrypto ?? (webcrypto as SourceAleatoire);
}

/** Tire `longueur` octets cryptographiquement aléatoires. */
function octetsAleatoires(longueur: number): Uint8Array {
  const tableau = new Uint8Array(longueur);
  moteurAlea().getRandomValues(tableau);
  return tableau;
}

/** Lit le bit `index` (0 = poids fort) d'un tableau d'octets big-endian. */
function bitA(octets: Uint8Array, index: number): number {
  return ((octets[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;
}

/** Encode les `groupes` premiers paquets de 5 bits en base32 Crockford. */
function encoderBase32(octets: Uint8Array, groupes: number): string {
  let sortie = "";
  for (let groupe = 0; groupe < groupes; groupe += 1) {
    let valeur = 0;
    for (let position = 0; position < 5; position += 1) {
      valeur = (valeur << 1) | bitA(octets, groupe * 5 + position);
    }
    sortie += ULID_ALPHABET[valeur];
  }
  return sortie;
}

/**
 * Encode un horodatage en millisecondes sur 10 caractères base32 — conversion
 * numérique en base 32 (l'horodatage < 2^48 tient dans 10 chiffres de 5 bits :
 * les 2 bits de poids fort du premier caractère restent nuls, conformité ULID).
 */
function encoderHorodatage(tempsMs: number): string {
  let reste = tempsMs;
  let sortie = "";
  for (let position = 0; position < 10; position += 1) {
    sortie = ULID_ALPHABET[reste % 32] + sortie;
    reste = Math.floor(reste / 32);
  }
  return sortie;
}

/** Incrémente un entier non signé de 80 bits (big-endian), retenue propagée. */
function incremente80(octets: Uint8Array): void {
  for (let index = octets.length - 1; index >= 0; index -= 1) {
    const octet = octets[index];
    if (octet < 255) {
      octets[index] = octet + 1;
      return;
    }
    octets[index] = 0;
  }
  throw new Error("newUlid: compteur aléatoire saturé (2^80 identifiants dans la même ms).");
}

/**
 * État de monotonie du process : dernière milliseconde émise + compteur
 * aléatoire associé. La lecture/incrément/écriture est synchrone (aucun
 * await) : atomicité garantie par le mono-thread JS.
 */
let ulidDerniereMs = -1;
let ulidDernierAlea = new Uint8Array(10);

/**
 * Génère un ULID de 26 caractères Crockford base32 : 10 caractères
 * d'horodatage (48 bits, ms) + 16 caractères d'aléa (80 bits, WebCrypto).
 * L'ordre lexicographique = l'ordre chronologique. MONOTONE dans le process :
 * à la même milliseconde que l'appel précédent, le compteur aléatoire est
 * incrémenté (jamais de tri instable entre deux IDs de la même ms).
 * Implémentation pure TypeScript — aucune dépendance externe.
 */
export function newUlid(now?: Date): string {
  const tempsMs = (now ?? new Date()).getTime();
  if (!Number.isInteger(tempsMs) || tempsMs < 0 || tempsMs >= 2 ** 48) {
    throw new Error("newUlid: horodatage hors domaine (entier de ms dans [0, 2^48[).");
  }

  let alea: Uint8Array;
  if (tempsMs === ulidDerniereMs) {
    // Même milliseconde que l'appel précédent : incrément du compteur.
    alea = Uint8Array.from(ulidDernierAlea);
    incremente80(alea);
  } else {
    alea = octetsAleatoires(10);
  }
  ulidDerniereMs = tempsMs;
  ulidDernierAlea = Uint8Array.from(alea);

  return encoderHorodatage(tempsMs) + encoderBase32(alea, 16);
}

/* ------------------------------------------------------------------ */
/* Absence — réexport de la sémantique identity-store                  */
/* ------------------------------------------------------------------ */

/**
 * Vrai si l'erreur signale une clé ABSENTE (GetObject 404 / NoSuchKey).
 * Réexporte la sémantique estAbsenceR2 (lib/identity/r2-identity-store).
 */
export function isAbsence(error: unknown): boolean {
  return estAbsenceR2(error);
}

/* ------------------------------------------------------------------ */
/* Sérialisation canonique                                             */
/* ------------------------------------------------------------------ */

/**
 * Tri récursif des clés — même algorithme que identity-store (trierProfond) :
 * objets aux clés triées, tableaux préservés dans l'ordre.
 */
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

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/** Valide un plafond d'octets fourni par l'appelant (entier ≥ 1). */
function assertCapValide(maxBytes: number): number {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new UserDataError("invalid", `Plafond d'octets invalide (${maxBytes}).`);
  }
  return maxBytes;
}

/**
 * Télécharge un objet R2 sous plafond et CLASSIFIE l'échec :
 * absence → not_found, dépassement du plafond → too_large, toute autre
 * erreur R2 → unavailable.
 */
async function telechargerPlafonne(key: string, maxBytes: number): Promise<Buffer> {
  try {
    return await downloadFromR2(key, maxBytes);
  } catch (error) {
    if (estAbsenceR2(error)) {
      throw new UserDataError("not_found", `Document absent : ${key}`, { cause: error });
    }
    if (error instanceof Error && /exceeds configured read limit/i.test(error.message)) {
      throw new UserDataError(
        "too_large",
        `Document trop grand pour la lecture (> ${maxBytes} octets) : ${key}`,
        { cause: error },
      );
    }
    throw new UserDataError("unavailable", `Stockage R2 indisponible en lecture : ${key}`, {
      cause: error,
    });
  }
}

/**
 * Lit un document JSON. Absent → UserDataError("not_found") ; JSON illisible
 * → "corrupted" ; trop grand → "too_large" ; panne R2 → "unavailable".
 * Plafond par défaut : 2× le plafond d'écriture par défaut (512 Ko).
 */
export async function readJson<T>(key: string, opts?: { maxBytes?: number }): Promise<T> {
  const maxBytes = assertCapValide(opts?.maxBytes ?? USER_DATA_DEFAULT_READ_CAP_BYTES);
  const buffer = await telechargerPlafonne(key, maxBytes);

  let parse: unknown;
  try {
    parse = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new UserDataError("corrupted", `Document JSON illisible : ${key}`, { cause: error });
  }
  return parse as T;
}

/**
 * Lit un document JSON ou retourne null s'il est absent. Les autres erreurs
 * (corrupted, too_large, unavailable, invalid) propagent — un document
 * corrompu n'est JAMAIS silencieusement confondu avec un document absent.
 */
export async function readJsonIfExists<T>(
  key: string,
  opts?: { maxBytes?: number },
): Promise<T | null> {
  try {
    return await readJson<T>(key, opts);
  } catch (error) {
    if (error instanceof UserDataError && error.code === "not_found") return null;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

/**
 * Écrit (crée OU remplace) un document JSON en forme canonique (clés triées
 * récursivement), contentType "application/json". Dépassement du plafond
 * (défaut 256 Ko) → UserDataError("too_large"), RIEN n'est écrit.
 */
export async function writeJson(
  key: string,
  value: unknown,
  opts?: { maxBytes?: number },
): Promise<void> {
  const maxBytes = assertCapValide(opts?.maxBytes ?? USER_DATA_DEFAULT_WRITE_CAP_BYTES);
  if (value === undefined) {
    throw new UserDataError("invalid", "writeJson: valeur undefined non sérialisable en JSON.");
  }
  const body = Buffer.from(JSON.stringify(trierProfond(value)), "utf8");
  if (body.byteLength > maxBytes) {
    throw new UserDataError(
      "too_large",
      `Document trop grand pour l'écriture (${body.byteLength} octets > ${maxBytes}) : ${key}`,
    );
  }
  try {
    await putObject({ key, body, contentType: "application/json", contentLength: body.byteLength });
  } catch (error) {
    throw new UserDataError("unavailable", `Stockage R2 indisponible en écriture : ${key}`, {
      cause: error,
    });
  }
}

/**
 * Read-merge-write : fusion SHALLOW du patch sur le document existant
 * ({ ...doc, ...patch }) puis réécriture ; retourne le doc fusionné.
 * Document absent → création { v: 1, ...patch } (convention de version du
 * contrat 109-0). NON atomique (pas de transaction R2) : les appelants
 * concurrents appliquent des patchs best-effort (retry à leur charge).
 */
export async function patchJson<T extends object>(
  key: string,
  patch: Partial<T>,
  opts?: { maxBytes?: number },
): Promise<T> {
  const existant = await readJsonIfExists<T>(key, opts);
  if (existant !== null && (typeof existant !== "object" || Array.isArray(existant))) {
    throw new UserDataError(
      "corrupted",
      `Document existant non objet JSON (patch impossible) : ${key}`,
    );
  }
  const fusion: T =
    existant === null ? ({ v: 1, ...patch } as T) : { ...existant, ...patch };
  await writeJson(key, fusion, opts);
  return fusion;
}

/* ------------------------------------------------------------------ */
/* Suppression                                                         */
/* ------------------------------------------------------------------ */

/**
 * Supprime une clé. Tolère l'absence (DeleteObject S3 ne renvoie normalement
 * pas 404, mais toute forme d'absence remontée est traitée comme succès —
 * idempotent, sûr pour les retries). Autre panne → UserDataError("unavailable").
 */
export async function removeKey(key: string): Promise<void> {
  try {
    await deleteObject(key);
  } catch (error) {
    if (estAbsenceR2(error)) return;
    throw new UserDataError("unavailable", `Stockage R2 indisponible en suppression : ${key}`, {
      cause: error,
    });
  }
}

/**
 * Purge les objets sous un préfixe (conformité RGPD) et retourne le nombre
 * supprimé. Suppression par lots de 10 en Promise.all (pression maîtrisée,
 * débit suffisant). Cap maxObjects par défaut 1000 — une purge au-delà est
 * poursuivie par un NOUVEL appel (removeKey est idempotent et les appelants
 * 109-b/c/d bouclent tant que le compte retourne le cap demandé).
 * Une erreur de suppression interrompt la purge (partielle, retentable).
 */
export async function removePrefix(
  prefix: string,
  opts?: { maxObjects?: number },
): Promise<number> {
  const cibles = await listKeys(prefix, { maxObjects: opts?.maxObjects ?? 1000 });
  let supprimes = 0;
  for (let index = 0; index < cibles.length; index += 10) {
    const lot = cibles.slice(index, index + 10);
    await Promise.all(lot.map((cible) => removeKey(cible.key)));
    supprimes += lot.length;
  }
  return supprimes;
}

/* ------------------------------------------------------------------ */
/* Listage                                                             */
/* ------------------------------------------------------------------ */

/**
 * Liste les objets sous un préfixe (clés, taille, date) via
 * listObjectsUnderPrefix (mapping sizeBytes→size, updatedAt→lastModified).
 * Cap par défaut 500 objets (même borne que le client R2 brut).
 */
export async function listKeys(
  prefix: string,
  opts?: { maxObjects?: number },
): Promise<Array<{ key: string; size: number; lastModified: string }>> {
  let objets: Awaited<ReturnType<typeof listObjectsUnderPrefix>>;
  try {
    objets = await listObjectsUnderPrefix(prefix, opts?.maxObjects ?? 500);
  } catch (error) {
    throw new UserDataError("unavailable", `Stockage R2 indisponible au listage : ${prefix}`, {
      cause: error,
    });
  }
  return objets.map((objet) => ({
    key: objet.key,
    size: objet.sizeBytes,
    lastModified: objet.updatedAt,
  }));
}

/**
 * Lit TOUS les documents JSON sous un préfixe, par lots de 10 lectures
 * concurrentes (readJsonIfExists), en s'arrêtant dès que `limit` documents
 * sont collectés (le dernier lot est tronqué au reste nécessaire).
 *
 * - `limit` : nombre maximal de documents RETOURNÉS (les documents ignorés
 *   ne consomment pas le budget) ; tronqué au lot en cours, jamais dépassé.
 * - `maxBytesPerDoc` : plafond de lecture individuel (défaut 512 Ko).
 * - `skipCorrupted` (défaut true) : les documents illibles (corrupted) ou
 *   trop grands (too_large) sont IGNORÉS — mais une panne R2 (unavailable)
 *   propage TOUJOURS : un scan silencieux sur stockage en feu est interdit.
 * - Les documents disparus entre listage et lecture (not_found) sont
 *   simplement ignorés (course bénigne).
 *
 * NB : seules les clés `.json` sont lues — ce magasin ne scanne que ses
 * propres documents. Les appelants qui mélangent plusieurs formes de clés
 * sous un même préfixe (ex. {cid}.json vs {cid}/messages/*.json) restent
 * responsables du filtrage fin par forme de clé.
 */
export async function listJson<T>(
  prefix: string,
  opts?: { limit?: number; maxBytesPerDoc?: number; skipCorrupted?: boolean },
): Promise<T[]> {
  const skipCorrupted = opts?.skipCorrupted ?? true;
  const limite = opts?.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit));
  const cibles = (await listKeys(prefix)).filter((cible) => cible.key.endsWith(".json"));

  const documents: T[] = [];
  // L'index avance du nombre de clés CONSOMMÉES (lot tronqué au reste) : un
  // document ignoré dans un lot tronqué ne fait jamais perdre des clés.
  for (let index = 0; index < cibles.length; ) {
    const restant = limite === undefined ? undefined : limite - documents.length;
    if (restant !== undefined && restant <= 0) break;
    const lot = cibles.slice(index, index + 10);
    const lotBorne = restant === undefined ? lot : lot.slice(0, restant);
    index += lotBorne.length;

    const lus = await Promise.all(
      lotBorne.map(async (cible) => {
        try {
          return await readJsonIfExists<T>(cible.key, { maxBytes: opts?.maxBytesPerDoc });
        } catch (error) {
          if (
            skipCorrupted &&
            error instanceof UserDataError &&
            (error.code === "corrupted" || error.code === "too_large")
          ) {
            return null; // document illisible : ignoré, le scan continue
          }
          throw error; // unavailable (ou skipCorrupted=false) propagent
        }
      }),
    );
    for (const lu of lus) {
      if (lu !== null) documents.push(lu);
    }
  }
  return documents;
}
