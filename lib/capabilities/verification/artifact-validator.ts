/**
 * ARTIFACT VALIDATOR (UCE) — vérification INDÉPENDANTE de l'existence et de
 * la cohérence des artefacts produits (fichiers, documents, archives).
 * Un artefact annoncé mais absent/vid est un échec, jamais un succès.
 */

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

export interface VerdictArtefact {
  verifie: boolean;
  existe: boolean;
  tailleOctets?: number;
  cause?: string;
}

/** Le fichier existe, n'est pas vide et (option) porte la bonne extension. */
export async function verifierFichier(chemin: string, attendu: { extensions?: string[]; tailleMinOctets?: number } = {}): Promise<VerdictArtefact> {
  try {
    const stat = await fs.stat(chemin);
    if (!stat.isFile()) return { verifie: false, existe: false, cause: "le chemin n'est pas un fichier régulier" };
    const tailleMin = attendu.tailleMinOctets ?? 1;
    if (stat.size < tailleMin) {
      return { verifie: false, existe: true, tailleOctets: stat.size, cause: `fichier trop petit (${stat.size} octets < ${tailleMin})` };
    }
    if (attendu.extensions?.length) {
      const ext = path.extname(chemin).toLowerCase().replace(/^\./, "");
      if (!attendu.extensions.includes(ext)) {
        return { verifie: false, existe: true, tailleOctets: stat.size, cause: `extension « ${ext} » hors attendu (${attendu.extensions.join(", ")})` };
      }
    }
    return { verifie: true, existe: true, tailleOctets: stat.size };
  } catch {
    return { verifie: false, existe: false, cause: "fichier introuvable (stat échoué)" };
  }
}

/** Le répertoire contient au moins un fichier (artefact de sortie réel). */
export async function verifierDossierNonVide(dossier: string): Promise<VerdictArtefact> {
  try {
    const entrees = await fs.readdir(dossier);
    const fichiers = entrees.filter((e) => !e.startsWith("."));
    if (fichiers.length === 0) return { verifie: false, existe: true, cause: "dossier vide" };
    return { verifie: true, existe: true };
  } catch {
    return { verifie: false, existe: false, cause: "dossier introuvable" };
  }
}
