/**
 * Lecteur TAR RÉEL (aucune dépendance) + détection 7z.
 *
 * La demande moteur documentaire liste les archives ZIP, 7Z, TAR : le ZIP
 * était déjà analysé (lib/documents/zip), le TAR n'était pas lu du tout (les
 * .tar tombaient en « binaire »), et le 7z tombait en binaire muet.
 *
 * TAR : en-têtes de 512 octets (format ustar/gnu), checksum vérifiée,
 * garde-fous de taille cumulée et par entrée — lecture seule, jamais
 * d'extraction disque (aucun risque de path traversal : les chemins restent
 * des chaînes renvoyées à l'analyste).
 *
 * 7Z : signature réelle (37 7A BC AF 27 1C) reconnue et annoncée ; la
 * décompression LZMA n'est PAS incluse dans le moteur local — le message
 * est honnête et actionnable (reconvertir en zip/tar), jamais une erreur
 * muette.
 */

/** Garde-fous alignés sur office-text.ts (2 Mo par entrée / cumulés). */
const MAX_TAILLE_ENTREE = 2_000_000;
const MAX_TOTAL_OCTETS = 8_000_000;
const MAX_ENTREES = 5_000;

export interface EntreeTar {
  chemin: string;
  taille: number;
  type: "fichier" | "dossier" | "lien" | "autre";
}

export interface LectureTar {
  entrees: EntreeTar[];
  /** Contenu texte des entrées lisibles (≤ 2 Mo chacune, cumul ≤ 8 Mo). */
  fichiersTexte: { chemin: string; contenu: string }[];
  avertissements: string[];
  erreurs: string[];
}

const TAILLE_BLOC = 512;

/** Somme octets d'un champ numérique TAR octal (« 0000644\0 » style). */
function lireOctal(bloc: Buffer, offset: number, longueur: number): number {
  const champ = bloc.subarray(offset, offset + longueur).toString("ascii").replace(/[\0 ]+$/g, "").trim();
  if (!champ) return 0;
  const n = Number.parseInt(champ, 8);
  return Number.isFinite(n) ? n : 0;
}

/** Nom d'entrée (prefix + name pour ustar, name seul pour v7). */
function lireChemin(bloc: Buffer): string {
  const prefixe = bloc.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  const nom = bloc.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  return prefixe ? `${prefixe}/${nom}` : nom;
}

/**
 * Lit un buffer TAR : liste complète des entrées + extraction texte des
 * fichiers lisibles (heuristique binaire : octet NUL dans les 2 000 premiers
 * octets → non textuel). Archive invalide → exception avec message clair.
 */
export function lireTar(buffer: Buffer): LectureTar {
  const avertissements: string[] = [];
  const erreurs: string[] = [];
  const entrees: EntreeTar[] = [];
  const fichiersTexte: { chemin: string; contenu: string }[] = [];

  if (buffer.length < TAILLE_BLOC || buffer.length % TAILLE_BLOC !== 0) {
    throw new Error("Archive TAR invalide (taille non alignée sur 512 octets).");
  }

  let cumul = 0;
  let position = 0;
  while (position + TAILLE_BLOC <= buffer.length) {
    const bloc = buffer.subarray(position, position + TAILLE_BLOC);

    // Deux blocs nuls consécutifs = fin d'archive (convention POSIX).
    if (bloc.every((b) => b === 0)) break;

    // Vérification de la checksum TAR : somme des octets d'en-tête avec le
    // champ checksum à 148 remplacé par des espaces, comparée en octal.
    const champChecksum = bloc.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim();
    const checksumDeclaree = Number.parseInt(champChecksum || "0", 8);
    const copie = Buffer.from(bloc);
    copie.fill(32, 148, 156);
    const checksumCalculee = copie.reduce((somme, b) => somme + b, 0);
    if (!Number.isFinite(checksumDeclaree) || checksumCalculee !== checksumDeclaree) {
      erreurs.push(`En-tête TAR corrompu à l'offset ${position} (checksum incohérente) — lecture interrompue.`);
      break;
    }

    const chemin = lireChemin(bloc);
    const taille = lireOctal(bloc, 124, 12);
    const indicateurType = String.fromCharCode(bloc[156] ?? 48);

    if (!chemin) {
      position += TAILLE_BLOC + Math.ceil(taille / TAILLE_BLOC) * TAILLE_BLOC;
      continue;
    }

    const type: EntreeTar["type"] =
      indicateurType === "5" ? "dossier" : indicateurType === "1" || indicateurType === "2" ? "lien" : indicateurType === "0" ? "fichier" : "autre";
    entrees.push({ chemin, taille, type });

    const debutDonnees = position + TAILLE_BLOC;
    const blocsDonnees = Math.ceil(taille / TAILLE_BLOC) * TAILLE_BLOC;

    if (type === "fichier" && taille > 0 && taille <= MAX_TAILLE_ENTREE) {
      cumul += taille;
      if (cumul > MAX_TOTAL_OCTETS) {
        avertissements.push("Contenu cumulé des entrées texte > 8 Mo : extraction arrêtée (liste complète conservée).");
        position = debutDonnees + blocsDonnees;
        continue;
      }
      const donnees = buffer.subarray(debutDonnees, debutDonnees + taille);
      const echantillon = donnees.subarray(0, 2_000);
      const binaire = echantillon.includes(0);
      if (!binaire) {
        fichiersTexte.push({ chemin, contenu: donnees.toString("utf8") });
      }
    } else if (type === "fichier" && taille > MAX_TAILLE_ENTREE) {
      avertissements.push(`Entrée ${chemin} ignorée (${Math.round(taille / 1024)} Ko > 2 Mo).`);
    }

    position = debutDonnees + blocsDonnees;

    if (entrees.length > MAX_ENTREES) {
      avertissements.push(`Archive très dense : lecture limitée à ${MAX_ENTREES} entrées.`);
      break;
    }
  }

  if (entrees.length === 0) {
    throw new Error("Archive TAR invalide ou vide (aucune entrée lisible).");
  }

  return { entrees, fichiersTexte, avertissements, erreurs };
}

/** Signature 7z réelle : 37 7A BC AF 27 1C (« 7z¼¯'\x1c »). */
export function estArchive7z(buffer: Buffer): boolean {
  return buffer.length >= 6 && buffer.subarray(0, 6).toString("hex") === "377abcaf271c";
}

/** Signature ZIP réelle : « PK\x03\x04 » (ou PK\x05\x06 archive vide). */
export function estArchiveZip(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const hex = buffer.subarray(0, 4).toString("hex");
  return hex === "504b0304" || hex === "504b0506";
}

/** Signature TAR : « ustar » à l'offset 257, ou checksum valide sur bloc 0. */
export function estArchiveTar(buffer: Buffer): boolean {
  if (buffer.length < TAILLE_BLOC) return false;
  if (buffer.subarray(257, 262).toString("ascii") === "ustar") return true;
  try {
    lireTar(buffer);
    return true;
  } catch {
    return false;
  }
}
