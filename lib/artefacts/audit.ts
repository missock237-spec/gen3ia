import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import {
  listConversations,
  listMessages,
} from "@/lib/chat/repository";
import { listArtifacts, addArtifactVersion, getArtifact } from "@/lib/domain/artifacts/repository";
import type { ConversationArtifact } from "@/lib/domain/conversations/types";
import { convertFileBuffer, isOwnedPermanentKey, IMPORT_MAX_FILE_BYTES } from "@/lib/files/import";
import {
  createPermanentDownloadUrl,
  listPermanentFilesWithMetadata,
  storePermanentFile,
  sanitizeFilename,
} from "@/lib/storage/permanent-user-storage";
import { downloadFromR2, headR2Object, listObjectsUnderPrefix } from "@/lib/storage/r2";
import { createVideoPlaybackUrl, isOwnedVideoKey } from "@/lib/video/storage";

import {
  ajouterVersion,
  enregistrerPremiereVersion,
  identifiantRegistreValide,
  listerPointeurs,
  listerVersions,
  lirePointeur,
  lireVersionCourante,
  majNote,
  PREFIXE_ID_REGISTRE,
  type ArtefactPointeur,
  type RaisonVersion,
} from "./versions";

/**
 * AUDIT D'ARTEFACTS — gen3 connaît ses anciennes conversations et retrouve
 * tout ce qu'il a CRÉÉ (images, audios, rendus vidéo, documents générés,
 * fichiers de workspace) OU ce que l'utilisateur lui a DONNÉ (pièces jointes
 * importées, documents convertis), puis MODIFIE ces artefacts (remplacement
 * de contenu, renommage, correction) avec une TRACE DE VERSIONS.
 *
 * Sources agrégées (toutes owner-scopées par l'uid, cap de scan par source,
 * échec d'une source collecté dans `erreurs` — JAMAIS silencié, les autres
 * sources continuent) :
 *
 *  1. REGISTRE DE VERSIONS   (`users/{uid}/artefacts/…` — lib/artefacts/versions)
 *     : artefacts déjà modifiés au moins une fois ; leur clé COURANTE est
 *     « revendiquée » pour éviter tout doublon avec la liste brute R2 ;
 *  2. STOCKAGE PERMANENT R2  (`users/{uid}/permanent/…` — listPermanentFilesWithMetadata
 *     : import utilisateur, ai-images, ai-audio, workspaces, captures…) ;
 *  3. RENDUS VIDÉO           (`users/{uid}/video/{projectId}/renders|versions`
 *     — clés validées par isOwnedVideoKey) ;
 *  4. MESSAGES DES CONVERSATIONS (dépôt chat R2 par utilisateur) : rattachent
 *     chaque clé à SA conversation (id + titre + date), déduisent l'ORIGINE
 *     (pièce jointe = utilisateur ; image/audio générés = gen3), et exposent
 *     les projets vidéo produits (videoProjectId) ;
 *  5. FICHIERS IMPORTÉS      (r2fs `importedFiles` — documents convertis dont
 *     le binaire n'est pas forcément en stockage permanent) ;
 *  6. ARTEFACTS DE CONVERSATION (r2fs `conversationArtifacts` — livrables
 *     standardisés déjà versionnés par le dépôt existant).
 *
 * BARRIÈRE DE PROPRIÉTÉ : toute clé exposée passe isOwnedPermanentKey /
 * isOwnedVideoKey du propriétaire de l'exécution — une clé d'un autre
 * utilisateur est JAMAIS listée, lisible ni modifiable (les helpers existants
 * du dépôt sont réutilisés tels quels, pas réimplémentés).
 */

/* ------------------------------------------------------------------ */
/* Types publics                                                       */
/* ------------------------------------------------------------------ */

export type TypeArtefact = "document" | "image" | "video" | "audio" | "archive" | "code";
export type OrigineArtefact = "gen3" | "utilisateur";

export interface Artefact {
  /** Clé R2 brute · `ar:<ulid>` (registre) · `ca:<id>` (conversationArtifacts) · `if:<id>` (importedFiles) · `vp:<projectId>`. */
  id: string;
  nom: string;
  type: TypeArtefact;
  conversationId?: string;
  conversationTitre?: string;
  creeLe: string;
  modifieLe: string;
  tailleOctets: number;
  origine: OrigineArtefact;
  /** Clé de stockage COURANTE (null = contenu hébergé ailleurs, ex. import texte sans binaire). */
  cleStockage: string | null;
  /** Version courante (registre : n ; dépôt conversationArtifacts : versions[0] ; sinon 1). */
  version: number;
}

export interface FiltresArtefacts {
  type?: TypeArtefact;
  origine?: OrigineArtefact;
  conversationId?: string;
  /** Sous-chaîne insensible à la casse sur le nom ou la clé de stockage. */
  recherche?: string;
  /** Défaut 100 — cap 200. */
  limite?: number;
  /** Défaut 0. */
  offset?: number;
}

export interface ResultatListing {
  artefacts: Artefact[];
  /** Total APRÈS filtres, AVANT pagination — pilote une pagination honnête. */
  total: number;
  /** Vrai quand un cap de scan source a été atteint (la liste peut être incomplète). */
  tronque: boolean;
  /** Échecs d'accès PAR SOURCE (collectés, jamais silenciés). */
  erreurs: Array<{ source: string; message: string }>;
}

export interface LectureArtefact {
  id: string;
  nom: string;
  type: TypeArtefact;
  tailleOctets: number;
  contentType?: string;
  cleStockage: string | null;
  version: number;
  creeLe: string;
  modifieLe: string;
  conversationId?: string;
  conversationTitre?: string;
  origine?: OrigineArtefact;
  /** Contenu TEXTUEL converti (documents, code) — plafonné à LECTURE_MAX_CHARS. */
  contenu?: string;
  conversion?: "full" | "metadata-only";
  /** URL signée courte durée (médias) — l'objet R2, lui, est permanent. */
  urlTelechargement?: string;
  tronque?: boolean;
  note?: string;
}

export interface ParamsModification {
  /** NOUVEAU contenu textuel (remplacement — crée une nouvelle version). */
  nouveauContenu?: string;
  /** NOUVEAU nom (libellé — crée une nouvelle version ; la clé R2 reste immuable). */
  nouveauNom?: string;
  /** Note libre attachée à la modification (ou au pointeur si seul champ). */
  note?: string;
}

export interface ResultatModification {
  id: string;
  version: number;
  nom: string;
  cleStockage: string | null;
  /** Clé AVANT modification (une version nouvelle clé est créée pour un contenu). */
  ancienneCle: string | null;
  raison: RaisonVersion;
  note?: string;
  modifieLe: string;
  /** Nombre de versions conservées dans l'historique. */
  historique: number;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

/** Plafond de caractères de contenu renvoyé par lireArtefact (parité file.read). */
const LECTURE_MAX_CHARS = 48_000;

/** Caps de scan par source — chaque dépassement pose `tronque: true`. */
const CAP_REGISTRE = 200;
const CAP_PERMANENT = 500;
const CAP_VIDEO = 300;
const CAP_CONVERSATIONS = 30;
const CAP_MESSAGES_PAR_CONVERSATION = 100;
const CAP_IMPORTS = 200;
const CAP_ARTEFACTS_CONV = 200;

/** Limites de pagination du listing. */
const LISTE_LIMITE_DEFAUT = 100;
const LISTE_LIMITE_MAX = 200;

/** Taille maximale d'un remplacement de contenu textuel (chars). */
const CONTENU_MAX_CHARS = 2_000_000;

/** Plafond de rendus scannés pour résoudre un projet vidéo (`vp:`). */
const CAP_RENDUS_PROJET = 50;

const EXTENSIONS_PAR_TYPE: Record<TypeArtefact, readonly string[]> = {
  document: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "csv", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "json", "html", "htm", "xml", "yaml", "yml", "epub"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"],
  video: ["mp4", "webm", "mov", "m4v", "mkv", "avi"],
  audio: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"],
  archive: ["zip", "tar", "gz", "tgz", "7z", "rar"],
  code: ["js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cc", "cpp", "h", "cs", "php", "sh", "bash", "sql", "toml", "swift", "kt"],
};

const MIME_PREFIX_MEDIA: ReadonlyArray<{ prefixe: string; type: TypeArtefact }> = [
  { prefixe: "image/", type: "image" },
  { prefixe: "video/", type: "video" },
  { prefixe: "audio/", type: "audio" },
  { prefixe: "application/zip", type: "archive" },
  { prefixe: "application/gzip", type: "archive" },
  { prefixe: "application/x-tar", type: "archive" },
  { prefixe: "application/x-7z", type: "archive" },
];

/** Sous-dossiers du stockage permanent produits PAR gen3 (images/audios IA, workspaces, voix). */
const PREFIXES_GEN3: readonly string[] = [
  "/permanent/ai-images/",
  "/permanent/ai-audio/",
  "/permanent/neural-media/",
  "/permanent/professeur-media/",
  "/permanent/workspaces/",
  "/permanent/artefacts/",
];

/**
 * Préfixe `uuid-` posé par objectKey() (permanent-user-storage) sur les noms
 * d'objets — retiré pour le NOM AFFICHÉ de l'artefact (la clé de stockage,
 * elle, reste complète).
 */
const PREFIXE_UUID_CLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/** Nom lisible d'un artefact depuis sa clé (basename sans préfixe uuid-). */
function nomLisibleDepuisCle(cle: string): string {
  const basename = cle.split("/").pop() ?? cle;
  const sansPrefixe = basename.replace(PREFIXE_UUID_CLE, "");
  return sansPrefixe || basename;
}

/* ------------------------------------------------------------------ */
/* Helpers purs                                                        */
/* ------------------------------------------------------------------ */

function typeDepuisNom(filename: string, contentType?: string): TypeArtefact {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mime) {
    for (const regle of MIME_PREFIX_MEDIA) {
      if (mime.startsWith(regle.prefixe)) return regle.type;
    }
  }
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  for (const [type, extensions] of Object.entries(EXTENSIONS_PAR_TYPE) as Array<[TypeArtefact, readonly string[]]>) {
    if (extensions.includes(extension)) return type;
  }
  return "document";
}

function origineDepuisCle(key: string): OrigineArtefact {
  return PREFIXES_GEN3.some((prefixe) => key.includes(prefixe)) ? "gen3" : "utilisateur";
}

/**
 * Extrait la clé de stockage d'une URL MÉDIA DURABLE de l'app
 * (`/api/media/durable?path=users/…` — handle canonique des livraisons
 * image/audio persistées). Les URL présignées expirées ne sont PAS des
 * handles fiables : elles sont ignorées (jamais de devinette).
 */
function cleDepuisUrlDurable(url: string): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2000) return null;
  try {
    const parse = new URL(url, "https://origine.app");
    if (parse.pathname !== "/api/media/durable") return null;
    const cle = parse.searchParams.get("path") ?? "";
    return cle.startsWith("users/") && !cle.includes("..") ? cle : null;
  } catch {
    return null;
  }
}

/** Id de l'artefact régistre d'une clé (constance pour les tests comme pour l'UI). */
function idRegistre(artId: string): string {
  return `${PREFIXE_ID_REGISTRE}${artId}`;
}

function pointeurVersArtefact(p: ArtefactPointeur): Artefact {
  return {
    id: idRegistre(p.id),
    nom: p.nom,
    type: typeDepuisNom(p.nom, p.contentType),
    ...(p.conversationId ? { conversationId: p.conversationId } : {}),
    ...(p.conversationTitre ? { conversationTitre: p.conversationTitre } : {}),
    creeLe: p.creeLe,
    modifieLe: p.modifieLe,
    tailleOctets: p.tailleOctets,
    origine: p.origine,
    cleStockage: p.cleStockage,
    version: p.version,
  };
}

function artefactConvVersArtefact(a: ConversationArtifact): Artefact {
  const typeConv: Record<string, TypeArtefact> = {
    code: "code",
    document: "document",
    report: "document",
    table: "document",
    image: "image",
    video: "video",
    audio: "audio",
    file: "document",
  };
  const nom = a.filename || a.title;
  const tailleContenu = a.content ? Buffer.byteLength(a.content, "utf8") : 0;
  return {
    id: `ca:${a.id}`,
    nom,
    type: a.type === "file" ? typeDepuisNom(nom, undefined) : (typeConv[a.type] ?? "document"),
    ...(a.conversationId ? { conversationId: a.conversationId } : {}),
    creeLe: a.createdAt,
    modifieLe: a.updatedAt,
    tailleOctets: a.storagePath ? 0 : tailleContenu,
    origine: "gen3",
    cleStockage: a.storagePath ?? null,
    version: a.versions[0]?.version ?? 1,
  };
}

const KIND_VERS_TYPE: Record<string, TypeArtefact> = {
  image: "image",
  audio: "audio",
  video: "video",
  zip: "archive",
  tar: "archive",
  "7z": "archive",
};

function estMedia(type: TypeArtefact): boolean {
  return type === "image" || type === "video" || type === "audio";
}

/** Erreur d'absence propre (les appelants du tool la présentent telle quelle). */
function introuvable(id: string): Error {
  return new Error(`Artefact introuvable : ${id.slice(0, 120)}`);
}

function accesRefuse(): Error {
  return new Error("Accès refusé : cet artefact n'appartient pas à votre stockage.");
}

/* ------------------------------------------------------------------ */
/* 1. LISTER                                                           */
/* ------------------------------------------------------------------ */

/**
 * Liste TOUS les artefacts de l'utilisateur (multi-conversations) avec
 * filtres et pagination honnête : les caps de scan posent `tronque`, les
 * pannes d'une source sont COLLECTÉES dans `erreurs` sans masquer les autres.
 */
export async function listerArtefacts(userId: string, filtres: FiltresArtefacts = {}): Promise<ResultatListing> {
  const erreurs: Array<{ source: string; message: string }> = [];
  let tronque = false;
  const parId = new Map<string, Artefact>();
  /** Clés COURANTES revendiquées par le registre — pas de doublon avec le listage R2 brut. */
  const clesRevendiquees = new Set<string>();

  const annoter = (cle: string, annotation: { conversationId?: string; conversationTitre?: string; origine?: OrigineArtefact; creeLe?: string; typeForce?: TypeArtefact }): void => {
    const existant = parId.get(cle);
    if (!existant) return;
    if (annotation.conversationId && !existant.conversationId) existant.conversationId = annotation.conversationId;
    if (annotation.conversationTitre && !existant.conversationTitre) existant.conversationTitre = annotation.conversationTitre;
    if (annotation.origine) existant.origine = annotation.origine;
    if (annotation.typeForce) existant.type = annotation.typeForce;
    if (annotation.creeLe && annotation.creeLe < existant.creeLe) existant.creeLe = annotation.creeLe;
  };

  // 1) Registre de versions (artefacts déjà modifiés).
  try {
    const pointeurs = await listerPointeurs(userId, CAP_REGISTRE);
    if (pointeurs.length >= CAP_REGISTRE) tronque = true;
    for (const p of pointeurs) {
      parId.set(idRegistre(p.id), pointeurVersArtefact(p));
      if (p.cleStockage) clesRevendiquees.add(p.cleStockage);
      // TOUTES les clés de l'historique sont revendiquées : les anciennes
      // versions restent listables via l'historique du registre (`ar:`), pas
      // comme doublons du listing principal.
      try {
        for (const version of await listerVersions(userId, p.id)) {
          if (version.cleStockage) clesRevendiquees.add(version.cleStockage);
        }
      } catch (errorHistoire) {
        // L'historique d'UN pointeur illisible ne masque pas le registre :
        // l'état courant reste listé, l'incident est visible via erreurs.
        erreurs.push({ source: `registre:${p.id}`, message: errorHistoire instanceof Error ? errorHistoire.message : String(errorHistoire) });
      }
    }
  } catch (error) {
    erreurs.push({ source: "registre", message: error instanceof Error ? error.message : String(error) });
  }

  // 2) Stockage permanent R2 (+ métadonnées Firestore/r2fs `permanentFiles`).
  try {
    const permanents = await listPermanentFilesWithMetadata(userId);
    if (permanents.length >= CAP_PERMANENT) tronque = true;
    for (const f of permanents) {
      if (!isOwnedPermanentKey(userId, f.path) || clesRevendiquees.has(f.path)) continue;
      parId.set(f.path, {
        id: f.path,
        nom: nomLisibleDepuisCle(f.filename),
        type: typeDepuisNom(f.filename, f.contentType),
        creeLe: f.uploadedAt,
        modifieLe: f.uploadedAt,
        tailleOctets: f.sizeBytes,
        origine: origineDepuisCle(f.path),
        cleStockage: f.path,
        version: 1,
      });
    }
  } catch (error) {
    erreurs.push({ source: "stockage-permanent", message: error instanceof Error ? error.message : String(error) });
  }

  // 3) Rendus vidéo du pipeline (masters/exports) — clés vidéo propriétaires uniquement.
  try {
    const videoObjects = await listObjectsUnderPrefix(`users/${userId}/video/`, CAP_VIDEO);
    if (videoObjects.length >= CAP_VIDEO) tronque = true;
    for (const objet of videoObjects) {
      if (!isOwnedVideoKey(userId, objet.key)) continue;
      if (!objet.key.includes("/renders/") && !objet.key.includes("/versions/")) continue;
      if (typeDepuisNom(objet.key) !== "video") continue;
      if (clesRevendiquees.has(objet.key)) continue;
      parId.set(objet.key, {
        id: objet.key,
        nom: nomLisibleDepuisCle(objet.key),
        type: "video",
        creeLe: objet.updatedAt || new Date(0).toISOString(),
        modifieLe: objet.updatedAt || new Date(0).toISOString(),
        tailleOctets: objet.sizeBytes,
        origine: "gen3",
        cleStockage: objet.key,
        version: 1,
      });
    }
  } catch (error) {
    erreurs.push({ source: "video-rendus", message: error instanceof Error ? error.message : String(error) });
  }

  // 4) Conversations & messages — rattachement à la conversation + origine.
  try {
    const conversations = await listConversations(userId, CAP_CONVERSATIONS);
    if (conversations.length >= CAP_CONVERSATIONS) tronque = true;
    for (const conv of conversations) {
      const messages = await listMessages(userId, conv.id, CAP_MESSAGES_PAR_CONVERSATION, { order: "asc" }).catch((error: unknown) => {
        erreurs.push({ source: `messages:${conv.id}`, message: error instanceof Error ? error.message : String(error) });
        return [];
      });
      for (const message of messages) {
        for (const piece of message.attachments ?? []) {
          // Pièce jointe = donnée DONNÉE par l'utilisateur — seulement si la
          // clé appartient à SON stockage (barrière stricte, jamais annotée sinon).
          if (piece.path && isOwnedPermanentKey(userId, piece.path)) {
            annoter(piece.path, { conversationId: conv.id, conversationTitre: conv.title, origine: "utilisateur", creeLe: message.createdAt });
          }
        }
        const cleImage = message.imageUrl ? cleDepuisUrlDurable(message.imageUrl) : null;
        if (cleImage && isOwnedPermanentKey(userId, cleImage)) {
          annoter(cleImage, { conversationId: conv.id, conversationTitre: conv.title, origine: "gen3", creeLe: message.createdAt, typeForce: "image" });
        }
        const cleAudio = message.audioUrl ? cleDepuisUrlDurable(message.audioUrl) : null;
        if (cleAudio && isOwnedPermanentKey(userId, cleAudio)) {
          annoter(cleAudio, { conversationId: conv.id, conversationTitre: conv.title, origine: "gen3", creeLe: message.createdAt, typeForce: "audio" });
        }
        // Production vidéo pilotée depuis la conversation (rendus résolubles via `vp:`).
        if (message.videoProjectId) {
          const id = `vp:${message.videoProjectId}`;
          if (!parId.has(id)) {
            parId.set(id, {
              id,
              nom: `Vidéo (projet ${message.videoProjectId})`,
              type: "video",
              conversationId: conv.id,
              conversationTitre: conv.title,
              creeLe: message.createdAt,
              modifieLe: message.createdAt,
              tailleOctets: 0,
              origine: "gen3",
              cleStockage: `users/${userId}/video/${message.videoProjectId}/`,
              version: 1,
            });
          }
        }
      }
    }
  } catch (error) {
    erreurs.push({ source: "conversations", message: error instanceof Error ? error.message : String(error) });
  }

  // 5) Fichiers importés (r2fs `importedFiles` — documents convertis côté base).
  try {
    const snap = await adminDb.collection("importedFiles").where("userId", "==", userId).limit(CAP_IMPORTS).get();
    if (snap.size >= CAP_IMPORTS) tronque = true;
    snap.forEach((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const nom = typeof data.filename === "string" ? data.filename : "fichier importé";
      const kind = typeof data.kind === "string" ? data.kind : "";
      const chemin = typeof data.path === "string" && isOwnedPermanentKey(userId, data.path) ? data.path : null;
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : undefined;
      const creeLe = typeof data.createdAt === "string" ? data.createdAt : new Date(0).toISOString();
      if (chemin && parId.has(chemin)) {
        annoter(chemin, { conversationId, origine: "utilisateur", creeLe, typeForce: KIND_VERS_TYPE[kind] });
        return;
      }
      parId.set(`if:${doc.id}`, {
        id: `if:${doc.id}`,
        nom,
        type: KIND_VERS_TYPE[kind] ?? "document",
        ...(conversationId ? { conversationId } : {}),
        creeLe,
        modifieLe: creeLe,
        tailleOctets: Number(data.sizeBytes ?? 0),
        origine: "utilisateur",
        cleStockage: chemin,
        version: 1,
      });
    });
  } catch (error) {
    erreurs.push({ source: "fichiers-importes", message: error instanceof Error ? error.message : String(error) });
  }

  // 6) Artefacts de conversation (livrables standardisés, déjà versionnés).
  try {
    const artefactsConv = await listArtifacts(userId, { limit: CAP_ARTEFACTS_CONV });
    if (artefactsConv.length >= CAP_ARTEFACTS_CONV) tronque = true;
    for (const a of artefactsConv) {
      parId.set(`ca:${a.id}`, artefactConvVersArtefact(a));
      if (a.storagePath && isOwnedPermanentKey(userId, a.storagePath)) clesRevendiquees.add(a.storagePath);
    }
  } catch (error) {
    erreurs.push({ source: "artefacts-conversation", message: error instanceof Error ? error.message : String(error) });
  }

  // Filtres puis tri (modifié/créé le plus récent d'abord) puis pagination.
  let liste = [...parId.values()];
  if (filtres.type) liste = liste.filter((a) => a.type === filtres.type);
  if (filtres.origine) liste = liste.filter((a) => a.origine === filtres.origine);
  if (filtres.conversationId) liste = liste.filter((a) => a.conversationId === filtres.conversationId);
  const recherche = filtres.recherche?.trim().toLowerCase();
  if (recherche) {
    liste = liste.filter((a) => a.nom.toLowerCase().includes(recherche) || (a.cleStockage ?? "").toLowerCase().includes(recherche));
  }
  liste.sort((a, b) => (b.modifieLe || b.creeLe).localeCompare(a.modifieLe || a.creeLe));

  const total = liste.length;
  const offset = Math.max(0, Math.floor(filtres.offset ?? 0));
  const limite = Math.min(Math.max(1, Math.floor(filtres.limite ?? LISTE_LIMITE_DEFAUT)), LISTE_LIMITE_MAX);
  return { artefacts: liste.slice(offset, offset + limite), total, tronque, erreurs };
}

/* ------------------------------------------------------------------ */
/* 2. LIRE                                                             */
/* ------------------------------------------------------------------ */

async function lectureDepuisPermanent(userId: string, cle: string, base: { nom: string; contentType?: string; taille?: number; creeLe?: string; modifieLe?: string; version?: number; type?: TypeArtefact; conversationId?: string; conversationTitre?: string; origine?: OrigineArtefact }): Promise<LectureArtefact> {
  if (!isOwnedPermanentKey(userId, cle)) throw accesRefuse();
  const type = base.type ?? typeDepuisNom(base.nom, base.contentType);
  const commun = {
    id: cle,
    nom: base.nom,
    type,
    cleStockage: cle,
    version: base.version ?? 1,
    creeLe: base.creeLe ?? new Date(0).toISOString(),
    modifieLe: base.modifieLe ?? base.creeLe ?? new Date(0).toISOString(),
    ...(base.conversationId ? { conversationId: base.conversationId } : {}),
    ...(base.conversationTitre ? { conversationTitre: base.conversationTitre } : {}),
    ...(base.origine ? { origine: base.origine } : {}),
  };
  if (estMedia(type)) {
    const head = await headR2Object(cle).catch(() => null);
    return {
      ...commun,
      tailleOctets: head?.sizeBytes ?? base.taille ?? 0,
      contentType: head?.contentType ?? base.contentType,
      urlTelechargement: await createPermanentDownloadUrl(userId, cle),
      conversion: "metadata-only",
      note: "Média : contenu non textuel — URL signée de téléchargement (l'objet permanent n'expire pas, l'URL oui).",
    };
  }
  const buffer = await downloadFromR2(cle, IMPORT_MAX_FILE_BYTES);
  if (!buffer || buffer.length === 0) throw introuvable(cle);
  const conversion = await convertFileBuffer(buffer, base.nom, base.contentType ?? "application/octet-stream", buffer.length);
  const tronque = conversion.text.length > LECTURE_MAX_CHARS;
  return {
    ...commun,
    tailleOctets: buffer.length,
    contentType: base.contentType,
    conversion: conversion.conversion,
    contenu: conversion.text ? (tronque ? `${conversion.text.slice(0, LECTURE_MAX_CHARS)}…` : conversion.text) : (conversion.note ?? "(contenu non textuel — métadonnées seulement)"),
    tronque,
  };
}

/**
 * Lit un artefact de façon SÛRE : barrière de propriété stricte
 * (isOwnedPermanentKey / isOwnedVideoKey réutilisés du dépôt), contenu
 * textuel converti pour les documents/code, URL signée pour les médias.
 */
export async function lireArtefact(userId: string, id: string): Promise<LectureArtefact> {
  const idNet = typeof id === "string" ? id.trim() : "";
  if (!idNet) throw introuvable(idNet);

  // a) Registre de versions (`ar:<ulid>`) — contenu de la version COURANTE.
  const artId = identifiantRegistreValide(idNet);
  if (artId) {
    const pointeur = await lirePointeur(userId, artId);
    if (!pointeur) throw introuvable(idNet);
    const version = await lireVersionCourante(userId, artId);
    const cle = pointeur.cleStockage;
    if (!cle) throw new Error("Artefact du registre sans clé de stockage résoluable.");
    const lecture = await lectureDepuisPermanent(userId, cle, {
      nom: pointeur.nom,
      contentType: version?.contentType ?? pointeur.contentType,
      creeLe: pointeur.creeLe,
      modifieLe: pointeur.modifieLe,
      version: pointeur.version,
      conversationId: pointeur.conversationId,
      conversationTitre: pointeur.conversationTitre,
      origine: pointeur.origine,
    });
    return { ...lecture, ...(pointeur.note ? { note: pointeur.note } : {}) };
  }

  // b) Artefact de conversation (`ca:<id>`) — dépôt existant, versions incluses.
  if (idNet.startsWith("ca:")) {
    const suffixe = idNet.slice(3);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffixe)) throw introuvable(idNet);
    const artefact = await getArtifact(userId, suffixe);
    if (!artefact) throw introuvable(idNet);
    if (artefact.content) {
      const tronque = artefact.content.length > LECTURE_MAX_CHARS;
      return {
        id: idNet,
        nom: artefact.filename || artefact.title,
        type: artefactConvVersArtefact(artefact).type,
        cleStockage: artefact.storagePath ?? null,
        version: artefact.versions[0]?.version ?? 1,
        creeLe: artefact.createdAt,
        modifieLe: artefact.updatedAt,
        ...(artefact.conversationId ? { conversationId: artefact.conversationId } : {}),
        origine: "gen3",
        tailleOctets: Buffer.byteLength(artefact.content, "utf8"),
        contenu: tronque ? `${artefact.content.slice(0, LECTURE_MAX_CHARS)}…` : artefact.content,
        conversion: "full",
        tronque,
      };
    }
    if (artefact.storagePath && isOwnedPermanentKey(userId, artefact.storagePath)) {
      return lectureDepuisPermanent(userId, artefact.storagePath, {
        nom: artefact.filename || artefact.title,
        version: artefact.versions[0]?.version ?? 1,
        creeLe: artefact.createdAt,
        modifieLe: artefact.updatedAt,
        conversationId: artefact.conversationId,
        origine: "gen3",
      });
    }
    if (artefact.storagePath && isOwnedVideoKey(userId, artefact.storagePath)) {
      const head = await headR2Object(artefact.storagePath).catch(() => null);
      return {
        id: idNet,
        nom: artefact.filename || artefact.title,
        type: "video",
        cleStockage: artefact.storagePath,
        version: artefact.versions[0]?.version ?? 1,
        creeLe: artefact.createdAt,
        modifieLe: artefact.updatedAt,
        ...(artefact.conversationId ? { conversationId: artefact.conversationId } : {}),
        origine: "gen3",
        tailleOctets: head?.sizeBytes ?? 0,
        contentType: head?.contentType,
        urlTelechargement: await createVideoPlaybackUrl(userId, artefact.storagePath),
        conversion: "metadata-only",
      };
    }
    return {
      id: idNet,
      nom: artefact.filename || artefact.title,
      type: artefactConvVersArtefact(artefact).type,
      cleStockage: artefact.storagePath ?? null,
      version: artefact.versions[0]?.version ?? 1,
      creeLe: artefact.createdAt,
      modifieLe: artefact.updatedAt,
      ...(artefact.conversationId ? { conversationId: artefact.conversationId } : {}),
      origine: "gen3",
      tailleOctets: 0,
      conversion: "metadata-only",
      note: artefact.url ? "Artefact exposé par URL (handle externe) — contenu non résoluble en texte." : "Artefact sans contenu résoluable.",
    };
  }

  // c) Fichier importé (`if:<id>`) — contenu converti stocké côté r2fs.
  if (idNet.startsWith("if:")) {
    const suffixe = idNet.slice(3);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffixe)) throw introuvable(idNet);
    const snap = await adminDb.collection("importedFiles").doc(suffixe).get();
    const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
    // Garde d'ownership : le fichier d'un autre utilisateur est indiscernable d'un absent.
    if (!data || String(data.userId ?? "") !== userId) throw introuvable(idNet);
    const nom = typeof data.filename === "string" ? data.filename : "fichier importé";
    const chemin = typeof data.path === "string" && isOwnedPermanentKey(userId, data.path) ? data.path : null;
    const texte = typeof data.textContent === "string" ? data.textContent : "";
    const tronque = texte.length > LECTURE_MAX_CHARS;
    const commun: LectureArtefact = {
      id: idNet,
      nom,
      type: KIND_VERS_TYPE[typeof data.kind === "string" ? data.kind : ""] ?? "document",
      cleStockage: chemin,
      version: 1,
      creeLe: typeof data.createdAt === "string" ? data.createdAt : new Date(0).toISOString(),
      modifieLe: typeof data.createdAt === "string" ? data.createdAt : new Date(0).toISOString(),
      ...(typeof data.conversationId === "string" ? { conversationId: data.conversationId } : {}),
      origine: "utilisateur",
      tailleOctets: Number(data.sizeBytes ?? 0),
      contentType: typeof data.contentType === "string" ? data.contentType : undefined,
      conversion: data.conversion === "metadata-only" ? "metadata-only" : "full",
      contenu: texte ? (tronque ? `${texte.slice(0, LECTURE_MAX_CHARS)}…` : texte) : undefined,
      tronque: texte ? tronque : undefined,
    };
    if (!commun.contenu && chemin) return lectureDepuisPermanent(userId, chemin, commun);
    return commun;
  }

  // d) Projet vidéo (`vp:<projectId>`) — résolution du rendu final le plus récent.
  if (idNet.startsWith("vp:")) {
    const projectId = idNet.slice(3);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId)) throw introuvable(idNet);
    const rendus = (await listObjectsUnderPrefix(`users/${userId}/video/${projectId}/renders/`, CAP_RENDUS_PROJET).catch(() => []))
      .filter((objet) => isOwnedVideoKey(userId, objet.key) && typeDepuisNom(objet.key) === "video")
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    if (rendus.length === 0) {
      throw new Error("Aucun rendu final disponible pour ce projet vidéo (production en cours ou dossier vide).");
    }
    const rendu = rendus[0];
    const head = await headR2Object(rendu.key).catch(() => null);
    return {
      id: idNet,
      nom: rendu.key.split("/").pop() ?? idNet,
      type: "video",
      cleStockage: rendu.key,
      version: 1,
      creeLe: rendu.updatedAt || new Date(0).toISOString(),
      modifieLe: rendu.updatedAt || new Date(0).toISOString(),
      origine: "gen3",
      tailleOctets: head?.sizeBytes ?? rendu.sizeBytes,
      contentType: head?.contentType,
      urlTelechargement: await createVideoPlaybackUrl(userId, rendu.key),
      conversion: "metadata-only",
      ...(rendus.length > 1 ? { note: `${rendus.length} rendus disponibles — le plus récent est retourné.` } : {}),
    };
  }

  // e) Clé de stockage brute (permanent OU vidéo propriétaire).
  if (idNet.startsWith("users/")) {
    if (isOwnedPermanentKey(userId, idNet)) {
      const nom = nomLisibleDepuisCle(idNet);
      return lectureDepuisPermanent(userId, idNet, { nom, origine: origineDepuisCle(idNet) });
    }
    if (isOwnedVideoKey(userId, idNet)) {
      const head = await headR2Object(idNet).catch(() => null);
      // Horodatage honnête : re-listage borné du dossier parent pour retrouver
      // l'objet exact (LastModified) — sans lui, epoch 1970 assumé.
      const dossierParent = idNet.slice(0, idNet.lastIndexOf("/") + 1);
      const objetConnu = (await listObjectsUnderPrefix(dossierParent, CAP_RENDUS_PROJET).catch(() => []))
        .find((objet) => objet.key === idNet);
      const horodatage = objetConnu?.updatedAt || new Date(0).toISOString();
      return {
        id: idNet,
        nom: nomLisibleDepuisCle(idNet),
        type: typeDepuisNom(idNet, head?.contentType),
        cleStockage: idNet,
        version: 1,
        creeLe: horodatage,
        modifieLe: horodatage,
        origine: "gen3",
        tailleOctets: head?.sizeBytes ?? 0,
        contentType: head?.contentType,
        urlTelechargement: await createVideoPlaybackUrl(userId, idNet),
        conversion: "metadata-only",
      };
    }
    // Clé d'un AUTRE utilisateur ou famille inconnue : refus explicite.
    throw accesRefuse();
  }

  throw introuvable(idNet);
}

/* ------------------------------------------------------------------ */
/* 3. MODIFIER (nouvelle version — jamais d'écrasement silencieux)     */
/* ------------------------------------------------------------------ */

/**
 * Modifie un artefact en créant une NOUVELLE VERSION :
 *  - remplacement de contenu : upload R2 sous une NOUVELLE clé permanente
 *    (storePermanentFile — quota + nom sûr) — l'objet d'origine n'est jamais
 *    réécrit ni supprimé ;
 *  - renommage : libellé du pointeur (les clés R2 sont immuables — le nom
 *    affiché change, la clé courante reste, signalé dans la réponse) ;
 *  - note seule : métadonnée du pointeur, sans nouvelle version.
 *
 * L'artefact entre au REGISTRE dès la première modification : v1 = état
 * d'origine (restera listable), v2+ = modifications. Barrière de propriété
 * identique à lireArtefact.
 */
export async function modifierArtefact(userId: string, id: string, params: ParamsModification): Promise<ResultatModification> {
  const idNet = typeof id === "string" ? id.trim() : "";
  if (!idNet) throw introuvable(idNet);
  const aContenu = typeof params.nouveauContenu === "string" && params.nouveauContenu.length > 0;
  const aNom = typeof params.nouveauNom === "string" && params.nouveauNom.trim().length > 0;
  const aNote = typeof params.note === "string" && params.note.trim().length > 0;
  if (!aContenu && !aNom && !aNote) throw new Error("Modification vide : fournissez nouveauContenu, nouveauNom ou note.");

  // a) Artefact de conversation (`ca:`) — versionne via le dépôt EXISTANT.
  if (idNet.startsWith("ca:")) {
    const suffixe = idNet.slice(3);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffixe)) throw introuvable(idNet);
    if (aNom) throw new Error("Renommage non supporté pour un artefact de conversation (title) : modifiez le contenu ou utilisez le registre.");
    const existant = await getArtifact(userId, suffixe);
    if (!existant) throw introuvable(idNet);
    const misAJour = await addArtifactVersion(userId, suffixe, {
      ...(aContenu ? { content: params.nouveauContenu } : {}),
      ...(aNote ? { note: params.note } : {}),
    });
    return {
      id: idNet,
      version: misAJour.versions[0]?.version ?? existant.versions[0]?.version ?? 1,
      nom: misAJour.filename || misAJour.title,
      cleStockage: misAJour.storagePath ?? null,
      ancienneCle: existant.storagePath ?? null,
      raison: aContenu ? "contenu" : "contenu+renommer",
      ...(aNote ? { note: params.note } : {}),
      modifieLe: misAJour.updatedAt,
      historique: misAJour.versions.length,
    };
  }

  // b) Registre ou clé permanente brute — chemin registre avec versions.
  const artId = identifiantRegistreValide(idNet);
  let base: {
    artId: string | null;
    nom: string;
    type: TypeArtefact;
    cleStockage: string | null;
    contentType: string;
    tailleOctets: number;
    creeLe: string;
    conversationId?: string;
    conversationTitre?: string;
    origine: OrigineArtefact;
  };

  if (artId) {
    const pointeur = await lirePointeur(userId, artId);
    if (!pointeur) throw introuvable(idNet);
    base = {
      artId,
      nom: pointeur.nom,
      type: typeDepuisNom(pointeur.nom, pointeur.contentType),
      cleStockage: pointeur.cleStockage,
      contentType: pointeur.contentType,
      tailleOctets: pointeur.tailleOctets,
      creeLe: pointeur.creeLe,
      conversationId: pointeur.conversationId,
      conversationTitre: pointeur.conversationTitre,
      origine: pointeur.origine,
    };
  } else if (idNet.startsWith("users/")) {
    if (!isOwnedPermanentKey(userId, idNet)) throw accesRefuse();
    const head = await headR2Object(idNet).catch(() => null);
    if (!head) throw introuvable(idNet);
    const nom = nomLisibleDepuisCle(idNet);
    base = {
      artId: null,
      nom,
      type: typeDepuisNom(nom, head.contentType),
      cleStockage: idNet,
      contentType: head.contentType,
      tailleOctets: head.sizeBytes,
      creeLe: new Date().toISOString(),
      origine: origineDepuisCle(idNet),
    };
  } else {
    throw new Error("Modification non supportée pour cet identifiant d'artefact (fichiers importés `if:` et projets vidéo `vp:` : utilisez les outils dédiés).");
  }

  // Note seule : métadonnée du pointeur, SANS nouvelle version (rien d'édité).
  if (!aContenu && !aNom && base.artId) {
    const pointeur = await majNote(userId, base.artId, (params.note ?? "").trim());
    const historique = await listerVersions(userId, base.artId);
    return {
      id: idRegistre(base.artId),
      version: pointeur.version,
      nom: pointeur.nom,
      cleStockage: pointeur.cleStockage,
      ancienneCle: pointeur.cleStockage,
      raison: "origine",
      ...(pointeur.note ? { note: pointeur.note } : {}),
      modifieLe: pointeur.modifieLe,
      historique: historique.length,
    };
  }

  // Remplacement de contenu : réservé aux formats TEXTE (document/code).
  if (aContenu && !estDocumentTexte(base.type)) {
    throw new Error("Le remplacement de contenu n'est supporté que pour les documents et le code — les médias (image/audio/vidéo/archive) passent par leurs outils dédiés.");
  }
  if (aContenu && (params.nouveauContenu as string).length > CONTENU_MAX_CHARS) {
    throw new Error(`Contenu trop long (${(params.nouveauContenu as string).length} caractères, max ${CONTENU_MAX_CHARS}).`);
  }

  const nomFinal = aNom ? sanitizeFilename((params.nouveauNom as string).trim()) || base.nom : base.nom;
  let nouvelleCle = base.cleStockage;
  let nouvelleTaille = base.tailleOctets;
  let contentTypeFinal = base.contentType || "application/octet-stream";

  if (aContenu) {
    if (!base.cleStockage) throw new Error("Cet artefact n'a pas de binaire permanent : le remplacement de contenu est impossible (registre sans clé).");
    const contenu = Buffer.from(params.nouveauContenu as string, "utf8");
    const upload = await storePermanentFile({
      userId,
      filename: nomFinal,
      content: contenu,
      contentType: contentTypeFinal.startsWith("text/") || contentTypeFinal === "application/json" ? contentTypeFinal : "text/plain",
    });
    nouvelleCle = upload.path;
    nouvelleTaille = upload.sizeBytes;
    contentTypeFinal = upload.contentType;
  } else if (aNom && base.artId === null) {
    // Renommage d'une clé JAMAIS versionnée : le libellé change, la clé reste.
    contentTypeFinal = base.contentType || "application/octet-stream";
  }

  const raison: RaisonVersion = aContenu && aNom ? "contenu+renommer" : aContenu ? "contenu" : "renommer";

  if (!base.artId) {
    // Première modification d'une clé brute : v1 = état d'ORIGINE (l'objet
    // d'origine reste listable dans l'historique), puis v2 = modification.
    const pointeur = await enregistrerPremiereVersion(userId, {
      nom: base.nom,
      type: base.type,
      cleStockage: base.cleStockage,
      contentType: base.contentType || "application/octet-stream",
      tailleOctets: base.tailleOctets,
      origine: base.origine,
      creeLe: base.creeLe,
      conversationId: base.conversationId,
      conversationTitre: base.conversationTitre,
      note: aNote ? params.note : undefined,
    });
    const suivant = await ajouterVersion(userId, pointeur.id, {
      nom: nomFinal,
      cleStockage: nouvelleCle,
      tailleOctets: nouvelleTaille,
      contentType: contentTypeFinal,
      raison,
      note: aNote ? params.note : undefined,
    });
    const historique = await listerVersions(userId, pointeur.id);
    return {
      id: idRegistre(pointeur.id),
      version: suivant.version,
      nom: suivant.nom,
      cleStockage: suivant.cleStockage,
      ancienneCle: base.cleStockage,
      raison,
      ...(aNote ? { note: params.note } : {}),
      modifieLe: suivant.modifieLe,
      historique: historique.length,
    };
  }

  const suivant = await ajouterVersion(userId, base.artId, {
    nom: nomFinal,
    cleStockage: nouvelleCle,
    tailleOctets: nouvelleTaille,
    contentType: contentTypeFinal,
    raison,
    note: aNote ? params.note : undefined,
  });
  const historique = await listerVersions(userId, base.artId);
  return {
    id: idRegistre(base.artId),
    version: suivant.version,
    nom: suivant.nom,
    cleStockage: suivant.cleStockage,
    ancienneCle: base.cleStockage,
    raison,
    ...(aNote ? { note: params.note } : {}),
    modifieLe: suivant.modifieLe,
    historique: historique.length,
  };
}

/** Document/code = formats textuels modifiables par remplacement de contenu. */
function estDocumentTexte(type: TypeArtefact): boolean {
  return type === "document" || type === "code";
}
