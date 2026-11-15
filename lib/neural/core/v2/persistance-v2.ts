/**
 * PERSISTANCE DU CORTEX V2 — artefact binaire compact du cerveau élargi.
 *
 * Contenu persisté (état STRUCTURAL appris uniquement — les énergies sont
 * transitoires, comme v1) :
 *  - configuration du cortex columnnaire (colonnes, voisins, bandes, seed) ;
 *  - les poids CSR appris (Float32) ;
 *  - la graine d'entraînement du champ cortical (1e9 neurones) + sa
 *    modulation régionale (1000 × Float32).
 *
 * FORMAT BINAIRE (little-endian, via Buffer) :
 *   [0..5]   magic "GN3CV2"
 *   [6..9]   version (u32) = 1
 *   [10..13] colonnes (u32)
 *   [14..17] voisins (u32)
 *   [18..21] bandes (u32)
 *   [22..25] seed (u32)
 *   [26..29] seedEntrainement champ (u32)
 *   [30..33] epochs consolidés (u32)
 *   [34..37] samples consolidés (u32)
 *   [38..]   poids CSR (colonnes × voisins × f32)
 *   [...]    modulation régionale (1000 × f32)
 *
 * Garanties identiques à la persistance v1 : écriture ATOMIQUE (.tmp +
 * rename), échec NON FATAL, lecture synchrone unique au démarrage.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname } from "node:path";

import { CORTEX_CONFIG_DEFAUTS } from "./cortex-columnnaire";
import { REGIONS } from "./champ-cortical";

/** Magie + version du format. */
const MAGIC = "GN3CV2";
const VERSION_FORMAT = 1;
const TAILLE_ENTETE = 38;

/** État structural exportable du Cortex v2. */
export interface EtatStructuralV2 {
  colonnes: number;
  voisins: number;
  bandes: number;
  seed: number;
  seedEntrainement: number;
  epochsConsolides: number;
  samplesConsolides: number;
  poids: Float32Array;
  modulationRegionale: Float32Array;
}

/** Sérialise l'état structural en Buffer binaire compact. */
export function serialiserEtatV2(etat: EtatStructuralV2): Buffer {
  const nbPoids = etat.colonnes * etat.voisins;
  if (etat.poids.length !== nbPoids) {
    throw new Error(
      `Poids CSR incohérents : ${etat.poids.length} ≠ ${nbPoids}.`,
    );
  }
  const taille =
    TAILLE_ENTETE + nbPoids * 4 + etat.modulationRegionale.length * 4;
  const buf = Buffer.alloc(taille);
  buf.write(MAGIC, 0, "latin1");
  buf.writeUInt32LE(VERSION_FORMAT, 6);
  buf.writeUInt32LE(etat.colonnes, 10);
  buf.writeUInt32LE(etat.voisins, 14);
  buf.writeUInt32LE(etat.bandes, 18);
  buf.writeUInt32LE(etat.seed, 22);
  buf.writeUInt32LE(etat.seedEntrainement, 26);
  buf.writeUInt32LE(etat.epochsConsolides, 30);
  buf.writeUInt32LE(etat.samplesConsolides, 34);
  for (let i = 0; i < nbPoids; i++) {
    buf.writeFloatLE(etat.poids[i], TAILLE_ENTETE + i * 4);
  }
  const base = TAILLE_ENTETE + nbPoids * 4;
  for (let r = 0; r < etat.modulationRegionale.length; r++) {
    buf.writeFloatLE(etat.modulationRegionale[r], base + r * 4);
  }
  return buf;
}

/**
 * Désérialise un Buffer binaire. Retourne null si magie/version/tailles
 * incohérentes (corruption) — l'appelant repart sur un cortex neuf.
 */
export function deserialiserEtatV2(buf: Buffer): EtatStructuralV2 | null {
  try {
    if (buf.length < TAILLE_ENTETE) return null;
    if (buf.toString("latin1", 0, 6) !== MAGIC) return null;
    const version = buf.readUInt32LE(6);
    if (version !== VERSION_FORMAT) return null;
    const colonnes = buf.readUInt32LE(10);
    const voisins = buf.readUInt32LE(14);
    const bandes = buf.readUInt32LE(18);
    const nbPoids = colonnes * voisins;
    const tailleAttendue =
      TAILLE_ENTETE + nbPoids * 4 + REGIONS * 4;
    if (buf.length < tailleAttendue) return null;
    if (colonnes === 0 || voisins === 0 || bandes === 0) return null;
    if (colonnes > 100_000_000 || voisins > 64) return null; // gardes-fous

    const poids = new Float32Array(nbPoids);
    for (let i = 0; i < nbPoids; i++) {
      poids[i] = buf.readFloatLE(TAILLE_ENTETE + i * 4);
    }
    const base = TAILLE_ENTETE + nbPoids * 4;
    const modulationRegionale = new Float32Array(REGIONS);
    for (let r = 0; r < REGIONS; r++) {
      modulationRegionale[r] = buf.readFloatLE(base + r * 4);
    }
    return {
      colonnes,
      voisins,
      bandes,
      seed: buf.readUInt32LE(22),
      seedEntrainement: buf.readUInt32LE(26),
      epochsConsolides: buf.readUInt32LE(30),
      samplesConsolides: buf.readUInt32LE(34),
      poids,
      modulationRegionale,
    };
  } catch {
    return null;
  }
}

/** Écriture atomique (`.tmp` UNIQUE pid+uuid puis rename) — non fatale.
 * Durcissement 2026-10-22 : le `.tmp` fixe partagé permettait à deux
 * écritures concurrentes (runtime + entraînement) de se renommer mutuellement
 * un fichier PARTIEL — artefact corrompu au prochain démarrage. */
export async function ecrireArtefactV2(
  chemin: string,
  etat: EtatStructuralV2,
): Promise<boolean> {
  try {
    await fsp.mkdir(dirname(chemin), { recursive: true });
    const tmp = `${chemin}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, serialiserEtatV2(etat));
      await fsp.rename(tmp, chemin);
    } catch (erreur: unknown) {
      try {
        await fsp.unlink(tmp);
      } catch {
        // Rien à nettoyer.
      }
      throw erreur;
    }
    return true;
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL-V2] Écriture de l'artefact impossible (non fatal) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
    return false;
  }
}

/** Lecture synchrone (appel unique au démarrage). null si absent/corrompu. */
export function lireArtefactV2(chemin: string): EtatStructuralV2 | null {
  try {
    if (!existsSync(chemin)) return null;
    const buf = readFileSync(chemin);
    const etat = deserialiserEtatV2(buf);
    if (!etat) {
      console.warn(
        "[NEURAL-V2] Artefact corrompu ou format inconnu — cortex neuf.",
      );
    }
    return etat;
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL-V2] Lecture de l'artefact impossible (non fatal) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
    return null;
  }
}

/** Supprime l'artefact (reset complet). Non fatale. */
export function supprimerArtefactV2(chemin: string): void {
  try {
    if (existsSync(chemin)) unlinkSync(chemin);
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL-V2] Suppression de l'artefact impossible (non fatal) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
  }
}

/** Configuration par défaut exportée pour les vérifications de compat. */
export const CONFIG_CORTEX_DEFAUTS_V2 = CORTEX_CONFIG_DEFAUTS;
