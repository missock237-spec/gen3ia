import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

/**
 * genAPI — PACKAGE CLIENT + JETON D'USAGE UNIQUE.
 *
 * Le paquet livré au client SaaS (client.key + client.crt + gen3.proto +
 * LISEZMOI.md) est un tar maison DÉTERMINISTE compressé en gzip :
 *   [nomLen u16 BE][nom UTF-8][contenuLen u32 BE][contenu] × N
 * puis gzipSync. Format volontairement trivial : pas de dépendance tar
 * externe, extraction testable par aller-retour, aucune métadonnée
 * d'horodatage (le même contenu produit le même paquet — déterminisme
 * testable).
 *
 * Le paquet vit UNIQUEMENT en base64 dans Firestore (`genapiPackages`),
 * derrière un jeton d'usage unique (TTL 15 minutes) : le jeton CLAIR n'est
 * JAMAIS stocké — seul son SHA-256 (hashJeton) sert d'identifiant de
 * document. Après consommation, le paquetBase64 est écrasé par "".
 */

/** Durée de vie d'un lien de téléchargement de paquet : 15 minutes. */
export const JETON_TTL_MS = 15 * 60 * 1000;

/** Fichier à empaqueter : nom (UTF-8) + contenu texte ou binaire. */
export interface FichierPaquet {
  nom: string;
  contenu: string | Buffer;
}

/** Longueur maximale d'un nom de fichier empaqueté (u16 BE). */
const NOM_TAILLE_MAX = 65_535;
/** Longueur maximale d'un contenu (u32 BE). */
const CONTENU_TAILLE_MAX = 0xffff_ffff;

/**
 * Construit le paquet gzip déterministe (tar maison + gzipSync).
 * Fonction PURE : aucune I/O, testée par aller-retour avec extrairePaquet.
 */
export function construirePaquet(fichiers: FichierPaquet[]): Buffer {
  if (!Array.isArray(fichiers)) {
    throw new Error("construirePaquet: liste de fichiers invalide.");
  }
  const morceaux: Buffer[] = [];
  for (const fichier of fichiers) {
    if (!fichier || typeof fichier.nom !== "string" || fichier.nom.length === 0) {
      throw new Error("construirePaquet: nom de fichier requis.");
    }
    const nomBytes = Buffer.from(fichier.nom, "utf8");
    if (nomBytes.length > NOM_TAILLE_MAX) {
      throw new Error(`construirePaquet: nom trop long (${fichier.nom}).`);
    }
    const contenu =
      typeof fichier.contenu === "string"
        ? Buffer.from(fichier.contenu, "utf8")
        : fichier.contenu;
    if (!Buffer.isBuffer(contenu)) {
      throw new Error(`construirePaquet: contenu invalide (${fichier.nom}).`);
    }
    if (contenu.length > CONTENU_TAILLE_MAX) {
      throw new Error(`construirePaquet: contenu trop volumineux (${fichier.nom}).`);
    }
    const enteteNom = Buffer.alloc(2);
    enteteNom.writeUInt16BE(nomBytes.length, 0);
    const enteteContenu = Buffer.alloc(4);
    enteteContenu.writeUInt32BE(contenu.length, 0);
    morceaux.push(enteteNom, nomBytes, enteteContenu, contenu);
  }
  // gzip déterministe : zlib n'embarque AUCUNE horloge (champ MTIME à 0)
  // — le même contenu produit byte-pour-byte le même paquet.
  return gzipSync(Buffer.concat(morceaux));
}

/** Fichier extrait d'un paquet. */
export interface FichierExtrait {
  nom: string;
  contenu: Buffer;
}

/**
 * Inverse exact de construirePaquet : décompresse puis re-découpe le
 * format [nomLen u16][nom][contenuLen u32][contenu]. Jette en cas de
 * troncature ou de longueur incohérente (paquet corrompu = erreur propre).
 */
export function extrairePaquet(paquetGzip: Buffer): FichierExtrait[] {
  if (!Buffer.isBuffer(paquetGzip)) {
    throw new Error("extrairePaquet: paquet invalide (Buffer requis).");
  }
  let brut: Buffer;
  try {
    brut = gunzipSync(paquetGzip);
  } catch (erreur: unknown) {
    throw new Error(
      `extrairePaquet: décompression impossible (paquet corrompu) — ${erreur instanceof Error ? erreur.message : String(erreur)}`,
    );
  }
  const fichiers: FichierExtrait[] = [];
  let curseur = 0;
  while (curseur < brut.length) {
    if (curseur + 2 > brut.length) {
      throw new Error("extrairePaquet: entête de nom tronquée.");
    }
    const nomLen = brut.readUInt16BE(curseur);
    curseur += 2;
    if (curseur + nomLen > brut.length) {
      throw new Error("extrairePaquet: nom tronqué.");
    }
    const nom = brut.subarray(curseur, curseur + nomLen).toString("utf8");
    curseur += nomLen;
    if (curseur + 4 > brut.length) {
      throw new Error("extrairePaquet: entête de contenu tronquée.");
    }
    const contenuLen = brut.readUInt32BE(curseur);
    curseur += 4;
    if (curseur + contenuLen > brut.length) {
      throw new Error("extrairePaquet: contenu tronqué.");
    }
    fichiers.push({ nom, contenu: Buffer.from(brut.subarray(curseur, curseur + contenuLen)) });
    curseur += contenuLen;
  }
  return fichiers;
}

/**
 * Hash SHA-256 (hex minuscule) d'un jeton — fonction PURE exportée et
 * testée. Le document Firestore `genapiPackages/{hashJeton}` n'contient
 * JAMAIS le jeton clair : il ne servait à rien (le hash sert
 * d'identifiant), et sa fuite permettrait de télécharger le paquet.
 */
export function hasherJeton(jeton: string): string {
  return createHash("sha256").update(jeton, "utf8").digest("hex");
}

/**
 * Génère un jeton d'usage unique : 32 octets CSPRNG encodés base64url.
 * Le couple retourné sépare le jeton CLAIR (à placer dans l'URL de
 * téléchargement) de son hash (seul élément persisté).
 */
export function genererJetonUsageUnique(): { jeton: string; hashJeton: string } {
  const jeton = randomBytes(32).toString("base64url");
  return { jeton, hashJeton: hasherJeton(jeton) };
}
