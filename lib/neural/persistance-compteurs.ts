/**
 * PERSISTANCE DES COMPTEURS DE SOBRIÉTÉ (it.78 — anomalie levée : depuis
 * it.74/it.75, les deux compteurs d'énergie (moteur + pont vocation) vivaient
 * en MÉMOIRE du processus uniquement — chaque redéploiement (swap atomique +
 * rechargement PM2) remettait les sommes à zéro. La mesure était réelle mais
 * presque toujours vide : la sobriété affichée perdait son historique toutes
 * les deux heures environ. it.78 corrige cette limite HONNÊTEMENT : les
 * compteurs sont maintenant persistés sur disque et CONTINUENT à travers les
 * redéploiements — et si l'écriture est impossible, le repli mémoire est
 * DÉCLARÉ publiquement (jamais silencieux).
 *
 * Fichier : var/neural/compteurs-energie.json (convention var/ du dépôt,
 * gitignored — état LOCAL du processus, jamais committé). Écriture ATOMIQUE
 * (tmp + rename) : un crash ne peut pas laisser un JSON à moitié écrit.
 *
 * Chaque champ reste une SOMME D'ENTIERS MESURÉS — la persistance ne
 * « répare » rien et n'invente rien : elle recopie exactement les sommes
 * déjà comptées (on compte ce qui est arrivé, pas ce qui aurait pu
 * arriver) et conserve l'ORIGINE de la mesure (origineIso = démarrage de
 * la somme cumulée, qui survit aux redéploiements).
 *
 * Redirection (opérateur local / gardes) : variable d'environnement
 * GEN3_COMPTEURS_FICHIER — même philosophie que la priorité env > fichier
 * du profil d'énergie (it.74) ; non définie, le chemin par défaut s'applique.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Chemin par défaut (convention var/neural/ du dépôt, gitignored). */
export const FICHIER_COMPTEURS_DEFAUT = join(process.cwd(), "var", "neural", "compteurs-energie.json");

/** Variable d'environnement de redirection (opérateur local / gardes). */
export const VAR_ENV_FICHIER_COMPTEURS = "GEN3_COMPTEURS_FICHIER";

/** Version du format du fichier (évolution contrôlée, lecture tolérante). */
const VERSION_FORMAT = 2;

/** Bloc moteur (compteur it.74) — sommes d'entiers mesurées. */
export interface BlocMoteur {
  fenetresExecutees: number;
  fenetresEvitees: number;
  epoquesRPIAEvitees: number;
  cyclesNoyauEvites: number;
}

/** Bloc pont vocation (compteur it.75) — sommes d'entiers mesurées. */
export interface BlocPont {
  reponsesServies: number;
  refusHonnêtes: number;
}

/** État complet persisté. */
export interface EtatCompteurs {
  version: number;
  /** Origine de la somme cumulée (survit aux redéploiements). */
  origineIso: string;
  moteur?: BlocMoteur;
  pont?: BlocPont;
}

/** Mode de persistance déclaré publiquement (jamais silencieux). */
export type ModePersistance = "fichier" | "memoire";

const CLE_MODE = "__gen3CompteursPersistanceModeIt78";

function conteneurMode(): { mode: ModePersistance | null } {
  const global = globalThis as unknown as Record<string, unknown>;
  const existant = global[CLE_MODE] as { mode: ModePersistance | null } | undefined;
  if (existant) return existant;
  const neuf = { mode: null as ModePersistance | null };
  global[CLE_MODE] = neuf;
  return neuf;
}

/** Chemin réel du fichier (redirection env — lue à chaque appel, jamais figée). */
export function fichierCompteurs(): string {
  const env = process.env[VAR_ENV_FICHIER_COMPTEURS];
  return env && env.trim().length > 0 ? env.trim() : FICHIER_COMPTEURS_DEFAUT;
}

function estEntierPositif(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function estIsoValide(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(new Date(v).getTime());
}

/** Lecture tolérante : fichier absent/corrompu/mal formé → null (jamais d'exception). */
export function lireEtatCompteurs(): EtatCompteurs | null {
  try {
    const fichier = fichierCompteurs();
    if (!existsSync(fichier)) return null;
    const brut = JSON.parse(readFileSync(fichier, "utf8")) as Partial<EtatCompteurs>;
    if (typeof brut !== "object" || brut === null || !estIsoValide(brut.origineIso)) return null;
    return {
      version: estEntierPositif(brut.version) ? brut.version : VERSION_FORMAT,
      origineIso: brut.origineIso,
      moteur: brut.moteur && estEntierPositif(brut.moteur.fenetresExecutees) ? brut.moteur : undefined,
      pont: brut.pont && estEntierPositif(brut.pont.reponsesServies) ? brut.pont : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Persiste un bloc (moteur OU pont) en préservant l'autre : lecture du
 * fichier courant, fusion, écriture atomique. Retourne le succès — le
 * résultat est DÉCLARÉ publiquement par /api/energie (mode fichier/mémoire),
 * jamais avalé.
 */
export function persisterBlocCompteur(
  bloc: "moteur" | "pont",
  donnees: BlocMoteur | BlocPont,
  origineIso: string,
): boolean {
  try {
    const fichier = fichierCompteurs();
    const precedent = lireEtatCompteurs();
    const etat: EtatCompteurs = {
      version: VERSION_FORMAT,
      origineIso: precedent?.origineIso ?? origineIso,
      moteur: bloc === "moteur" ? (donnees as BlocMoteur) : precedent?.moteur,
      pont: bloc === "pont" ? (donnees as BlocPont) : precedent?.pont,
    };
    mkdirSync(join(fichier, ".."), { recursive: true });
    const tmp = `${fichier}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(etat, null, 2)}\n`, "utf8");
    renameSync(tmp, fichier);
    conteneurMode().mode = "fichier";
    return true;
  } catch {
    conteneurMode().mode = "memoire";
    return false;
  }
}

/** Efface le fichier (usage : garde/tests — jamais en production). */
export function effacerEtatCompteurs(): void {
  try {
    rmSync(fichierCompteurs(), { force: true });
  } catch {
    /* lecture d'état : l'absence de fichier est un état honnête */
  }
  conteneurMode().mode = null;
}

/**
 * Mode de persistance constaté : « fichier » dès qu'une écriture a réussi
 * (ou qu'un fichier lisible existe), « memoire » si l'écriture a échoué.
 * Avant toute constatation → null (l'appelant déclare l'état neutre).
 */
export function lireModePersistanceCompteurs(): ModePersistance | null {
  const mode = conteneurMode().mode;
  if (mode) return mode;
  return existsSync(fichierCompteurs()) && lireEtatCompteurs() !== null ? "fichier" : null;
}
