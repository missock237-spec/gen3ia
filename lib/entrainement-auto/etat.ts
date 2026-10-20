import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { EtatAutoApprentissage } from "./types";

/**
 * PERSISTANCE DE L'AUTO-APPRENTISSAGE — état plateforme (hors utilisateur),
 * écrit dans var/entrainement-auto/etat.json (var/ est déjà hors git — même
 * convention que var/neural/brain-v1.json).
 *
 * Écriture ATOMIQUE (tmp + rename), lecture tolérante (fichier absent ou
 * corrompu → état par défaut honnête, jamais d'exception remontée au boot).
 */

export const ETAT_AUTO_PATH = join(process.cwd(), "var", "entrainement-auto", "etat.json");

/** Caps de réduction (le fichier reste petit — écrit à chaque cycle). */
const HISTORIQUE_CAP = 10;
const DATASETS_CAP = 400;
const ERREURS_CAP = 5;

export function etatParDefaut(lanceA: string = new Date().toISOString()): EtatAutoApprentissage {
  return {
    v: 2,
    lanceA,
    cyclesExecutes: 0,
    enCours: false,
    dernierRapport: null,
    historique: [],
    datasetsIngestes: [],
    pairesCumulees: 0,
    echantillonsCumules: 0,
    absorptionCloturee: false,
    absorptionClotureeA: null,
    bilanAutonomie: null,
  };
}

/** Réapplique les caps (fichier borné même si un ancien état dérivait). */
export function reduireEtat(etat: EtatAutoApprentissage): EtatAutoApprentissage {
  return {
    ...etat,
    historique: etat.historique.slice(0, HISTORIQUE_CAP).map((rapport) => ({
      ...rapport,
      hubs: rapport.hubs.map((hub) => ({ ...hub, erreurs: hub.erreurs.slice(0, ERREURS_CAP) })),
    })),
    datasetsIngestes: etat.datasetsIngestes.slice(0, DATASETS_CAP),
  };
}

/** Forme brute tolérante — v1 (legacy) ET v2 (cycle de vie), aucun cast violent. */
interface EtatPersisteBrut {
  v?: number;
  lanceA?: string;
  cyclesExecutes?: number;
  enCours?: boolean;
  dernierRapport?: EtatAutoApprentissage["dernierRapport"];
  historique?: EtatAutoApprentissage["historique"];
  datasetsIngestes?: string[];
  pairesCumulees?: number;
  echantillonsCumules?: number;
  absorptionCloturee?: boolean;
  absorptionClotureeA?: string | null;
  bilanAutonomie?: EtatAutoApprentissage["bilanAutonomie"];
}

/**
 * Migration v1 → v2 : un ancien état (boucle périodique sans cycle de vie)
 * conserve TOUTES ses données (anti-rejoue, cumuls, historique) — seuls les
 * champs du cycle de vie sont ajoutés à leurs défauts neutres (fenêtre non
 * clôturée, bilan null). Lecture tolérante : absent/corrompu/version
 * inconnue → état par défaut honnête, jamais d'exception remontée au boot.
 */
export async function lireEtatAuto(chemin: string = ETAT_AUTO_PATH): Promise<EtatAutoApprentissage> {
  try {
    const brut = await readFile(chemin, "utf8");
    const parse = JSON.parse(brut) as EtatPersisteBrut | null;
    if (typeof parse !== "object" || parse === null) return etatParDefaut();
    if (parse.v !== 1 && parse.v !== 2) return etatParDefaut();
    return { ...etatParDefaut(), ...parse, v: 2 };
  } catch {
    return etatParDefaut();
  }
}

/** Écriture atomique (tmp + rename). @returns true si l'écriture a abouti. */
export async function ecrireEtatAuto(
  etat: EtatAutoApprentissage,
  chemin: string = ETAT_AUTO_PATH,
): Promise<boolean> {
  try {
    await mkdir(dirname(chemin), { recursive: true });
    const tmp = `${chemin}.tmp`;
    await writeFile(tmp, JSON.stringify(reduireEtat(etat)), "utf8");
    await rename(tmp, chemin);
    return true;
  } catch {
    return false;
  }
}
