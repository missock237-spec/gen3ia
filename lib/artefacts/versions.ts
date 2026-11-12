import "server-only";

import {
  listJson,
  listKeys,
  newUlid,
  patchJson,
  readJsonIfExists,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

/**
 * REGISTRE DE VERSIONS D'ARTEFACTS — historique persisté d'un artefact
 * modifié par l'audit (`lib/artefacts/audit.ts`).
 *
 * SCHÉMA (adossé à la mémoire R2 PAR UTILISATEUR, contrat Task 109-a —
 * mêmes primitives que le dépôt chat : readJsonIfExists/writeJson/patchJson
 * sur des documents JSON canoniques) :
 *
 *  - POINTEUR (état courant)   : `users/{uid}/artefacts/{artId}.json`
 *  - VERSION n                 : `users/{uid}/artefacts/{artId}/versions/{n}.json`
 *
 * Invariants :
 *  - l'identifiant est un ULID (tri chronologique, généré par newUlid) ;
 *  - l'uid est revalidé par userDir/userKey AVANT toute composition de clé
 *    (assertValidUid — traversée d'espace de clés impossible) ;
 *  - la garde d'ownership est reprise à la LECTURE (`userId` du document
 *    comparé à l'appelant) : le registre d'un autre utilisateur est
 *    indiscernable d'un registre absent ;
 *  - une version n'est JAMAIS écrasée : chaque modification écrit un
 *    document `versions/{n+1}` et met à jour le POINTEUR — l'ancien état
 *    reste listable dans l'historique ;
 *  - cap d'historique CAP_VERSIONS (50) aligné sur la convention du dépôt
 *    `conversationArtifacts` (versions[] tronquées à 50).
 */

/** Dossier utilisateur du registre (schéma de clés Task 109). */
const DOSSIER_ARTEFACTS = "artefacts";
const DOSSIER_VERSIONS = "versions";

/** Préfixe d'identifiant du registre dans l'audit d'artefacts (`ar:<ulid>`). */
export const PREFIXE_ID_REGISTRE = "ar:";

/** Cap d'historique conservé par artefact (parité conversationArtifacts). */
export const CAP_VERSIONS = 50;

/** Raison d'une version : état d'origine, remplacement de contenu, renommage. */
export type RaisonVersion = "origine" | "contenu" | "renommer" | "contenu+renommer";

/** Version enregistrée dans l'historique (jamais réécrite après coup). */
export interface VersionEnregistree {
  version: number;
  /** Nom de l'artefact à CETTE version (libellé affichable). */
  nom: string;
  /** Clé de stockage du contenu à CETTE version (null = contenu hébergé ailleurs). */
  cleStockage: string | null;
  tailleOctets: number;
  contentType: string;
  raison: RaisonVersion;
  note?: string;
  /** Date d'application de la version (ISO) — la v1 porte la date de création. */
  modifieLe: string;
}

/** Pointeur d'état courant d'un artefact du registre. */
export interface ArtefactPointeur {
  v: 1;
  /** ULID du registre (identité stable). */
  id: string;
  userId: string;
  nom: string;
  type: string;
  /** Clé du contenu COURANT (l'objet sous cette clé est la version active). */
  cleStockage: string | null;
  contentType: string;
  tailleOctets: number;
  /** Numéro de la version courante (n — voir versions/{n}.json). */
  version: number;
  origine: "gen3" | "utilisateur";
  conversationId?: string;
  conversationTitre?: string;
  /** Création de l'artefact d'ORIGINE (avant son entrée au registre). */
  creeLe: string;
  modifieLe: string;
  note?: string;
}

const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/**
 * Extrait l'ULID d'un identifiant de registre (`ar:<ulid>`) — null sinon.
 * Toute entrée hors format est traitée comme « introuvable » par les
 * appelants : aucune injection de segment de clé possible.
 */
export function identifiantRegistreValide(id: string): string | null {
  const brut = id.startsWith(PREFIXE_ID_REGISTRE) ? id.slice(PREFIXE_ID_REGISTRE.length) : "";
  return ULID_PATTERN.test(brut) ? brut : null;
}

/* ------------------------------------------------------------------ */
/* Clés canoniques                                                     */
/* ------------------------------------------------------------------ */

const clePointeur = (uid: string, artId: string) => userKey(uid, DOSSIER_ARTEFACTS, artId);
const cleVersion = (uid: string, artId: string, version: number) =>
  userKey(uid, DOSSIER_ARTEFACTS, artId, DOSSIER_VERSIONS, String(version));
const prefixeVersions = (uid: string, artId: string) => `${userDir(uid, DOSSIER_ARTEFACTS, artId, DOSSIER_VERSIONS)}/`;
const prefixeRegistre = (uid: string) => `${userDir(uid, DOSSIER_ARTEFACTS)}/`;

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lit le POINTEUR courant d'un artefact du registre. Garde d'ownership :
 * le pointeur d'un autre utilisateur (impossible par construction des clés,
 * vérifié ici par ceinture) est rendu indiscernable d'un pointeur absent.
 */
export async function lirePointeur(uid: string, artId: string): Promise<ArtefactPointeur | null> {
  if (!ULID_PATTERN.test(artId)) return null;
  const doc = await readJsonIfExists<ArtefactPointeur>(clePointeur(uid, artId));
  if (!doc || doc.userId !== uid || typeof doc.id !== "string") return null;
  return doc;
}

/** Historique des versions d'un artefact, de la plus récente à la plus ancienne. */
export async function listerVersions(uid: string, artId: string, cap = CAP_VERSIONS): Promise<VersionEnregistree[]> {
  if (!ULID_PATTERN.test(artId)) return [];
  const versions = await listJson<VersionEnregistree>(prefixeVersions(uid, artId), { limit: cap });
  return versions
    .filter((v) => Number.isInteger(v.version) && v.version >= 1)
    .sort((a, b) => b.version - a.version);
}

/** Version courante (celle que le POINTEUR désigne) — null si absente. */
export async function lireVersionCourante(uid: string, artId: string): Promise<VersionEnregistree | null> {
  const pointeur = await lirePointeur(uid, artId);
  if (!pointeur) return null;
  return readJsonIfExists<VersionEnregistree>(cleVersion(uid, artId, pointeur.version));
}

/**
 * Liste les POINTEURS du registre de l'utilisateur (documents directement
 * sous `users/{uid}/artefacts/` — les historiques `…/versions/*.json` ne
 * sont JAMAIS pris pour des pointeurs, même filtre de forme que le dépôt
 * chat sur `conversations/{cid}.json`).
 */
export async function listerPointeurs(uid: string, limit = 200): Promise<ArtefactPointeur[]> {
  const prefixe = prefixeRegistre(uid);
  const cles = (await listKeys(prefixe))
    .map((objet) => objet.key)
    .filter((key) =>
      key.startsWith(prefixe) &&
      key.endsWith(".json") &&
      !key.slice(prefixe.length, key.length - ".json".length).includes("/"),
    )
    .slice(0, Math.max(1, limit));
  const docs = await Promise.all(cles.map((key) => readJsonIfExists<ArtefactPointeur>(key)));
  const pointeurs: ArtefactPointeur[] = [];
  for (const doc of docs) {
    if (doc && doc.userId === uid && typeof doc.id === "string" && typeof doc.nom === "string") {
      pointeurs.push(doc);
    }
  }
  return pointeurs;
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

export interface BaseRegistre {
  nom: string;
  type: string;
  cleStockage: string | null;
  contentType: string;
  tailleOctets: number;
  origine: "gen3" | "utilisateur";
  /** Création de l'artefact d'origine (ISO) — la version 1 en hérite. */
  creeLe: string;
  conversationId?: string;
  conversationTitre?: string;
  note?: string;
}

/**
 * Enregistre un artefact JAMAIS encore versionné : écrit l'état d'origine
 * comme VERSION 1 (immutabilisée dans l'historique) puis le POINTEUR courant.
 * L'ULID est généré ici — l'appelant ne choisit jamais l'identifiant.
 */
export async function enregistrerPremiereVersion(uid: string, base: BaseRegistre): Promise<ArtefactPointeur> {
  const artId = newUlid();
  const pointeur: ArtefactPointeur = {
    v: 1,
    id: artId,
    userId: uid,
    nom: base.nom,
    type: base.type,
    cleStockage: base.cleStockage,
    contentType: base.contentType,
    tailleOctets: base.tailleOctets,
    version: 1,
    origine: base.origine,
    ...(base.conversationId ? { conversationId: base.conversationId } : {}),
    ...(base.conversationTitre ? { conversationTitre: base.conversationTitre } : {}),
    ...(base.note ? { note: base.note } : {}),
    creeLe: base.creeLe,
    modifieLe: base.creeLe,
  };
  await writeJson(cleVersion(uid, artId, 1), {
    version: 1,
    raison: "origine" as const,
    nom: base.nom,
    cleStockage: base.cleStockage,
    tailleOctets: base.tailleOctets,
    contentType: base.contentType,
    ...(base.note ? { note: base.note } : {}),
    modifieLe: base.creeLe,
  });
  await writeJson(clePointeur(uid, artId), pointeur);
  return pointeur;
}

/**
 * Applique une NOUVELLE version : écrit `versions/{n+1}` (immuable) PUIS
 * met à jour le POINTEUR courant. La version précédente reste intégralement
 * lisible via listerVersions — aucun écrasement d'historique.
 */
export async function ajouterVersion(
  uid: string,
  artId: string,
  suivante: {
    nom: string;
    cleStockage: string | null;
    tailleOctets: number;
    contentType: string;
    raison: RaisonVersion;
    note?: string;
  },
): Promise<ArtefactPointeur> {
  const pointeur = await lirePointeur(uid, artId);
  if (!pointeur) throw new Error("Artefact introuvable dans le registre de versions.");
  const version = pointeur.version + 1;
  const modifieLe = new Date().toISOString();
  await writeJson(cleVersion(uid, artId, version), {
    version,
    raison: suivante.raison,
    nom: suivante.nom,
    cleStockage: suivante.cleStockage,
    tailleOctets: suivante.tailleOctets,
    contentType: suivante.contentType,
    ...(suivante.note ? { note: suivante.note } : {}),
    modifieLe,
  });
  const patch = {
    nom: suivante.nom,
    cleStockage: suivante.cleStockage,
    tailleOctets: suivante.tailleOctets,
    contentType: suivante.contentType,
    version,
    modifieLe,
    ...(suivante.note ? { note: suivante.note } : {}),
  };
  await patchJson<ArtefactPointeur>(clePointeur(uid, artId), patch);
  return { ...pointeur, ...patch };
}

/** Met à jour la note libre du POINTEUR sans créer de version (métadonnée). */
export async function majNote(uid: string, artId: string, note: string): Promise<ArtefactPointeur> {
  const pointeur = await lirePointeur(uid, artId);
  if (!pointeur) throw new Error("Artefact introuvable dans le registre de versions.");
  await patchJson<ArtefactPointeur>(clePointeur(uid, artId), { note });
  return { ...pointeur, note };
}
