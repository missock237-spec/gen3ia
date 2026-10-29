import "server-only";

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

import type { ReseauNeuronalGen3 } from "../core/network";
import type { NeuralConfig } from "../core/types";
import type { TrainingReport } from "./trainer";
import type { EtatLangage } from "../generation/language";
import type { EtatRPIA } from "../core/couche-rpia";

/**
 * PERSISTANCE DU CERVEAU NEURONAL — état structural (config + synapses) et
 * mémoire lexicale (registre de tokens), écrits dans var/neural/brain-v1.json
 * (hors git, cf. .gitignore).
 *
 * Garanties :
 *  - écriture ATOMIQUE (fichier .tmp UNIQUE + rename) : un crash en cours
 *    d'écriture ne peut jamais corrompre le cerveau précédent ;
 *  - écriture SÉRIALISÉE (mutex interne) : plusieurs appelants concurrents
 *    (consolidation, entraînement auto, évolution, route evolve) ne peuvent
 *    plus entrer en course sur le même fichier — durcissement 2026-10-22 :
 *    l'ancien `.tmp` unique partagé faisait qu'une sauvegarde pouvait
 *    renommer le .tmp PARTIEL d'une autre ;
 *  - ROTATION .bak : la dernière version connue bonne est conservée ; au
 *    chargement, un cerveau illisible/corrompu retente le .bak AVANT de
 *    repartir sur un réseau neuf (amnésie en dernier recours, jamais
 *    silencieuse) ;
 *  - échec NON FATAL : la sauvegarde/lecture rate doucement (console.warn /
 *    retour null) — le système repart sur un réseau seedé neuf ;
 *  - loadBrainState est SYNCHRONE : appelé une unique fois au démarrage du
 *    runtime (getNeuralRuntime), avant tout cycle — le coût est négligeable.
 */

/** Chemin canonique du fichier de cerveau persisté. */
export const BRAIN_PATH = join(process.cwd(), "var/neural/brain-v1.json");

/** Chemin de la dernière version connue bonne (rotation avant chaque écriture). */
export const BRAIN_BAK_PATH = `${BRAIN_PATH}.bak`;

/**
 * MUTEX DE SAUVEGARDE — chaîne de promesses : chaque saveBrainState attend la
 * fin de la précédente. Les sauvegardes restent asynchrones (non bloquantes
 * pour l'event loop) mais ne se chevauchent plus jamais.
 */
let fileDeSauvegarde: Promise<boolean> = Promise.resolve(true);

/** Durée au-delà de laquelle un .tmp est un orphelin (process tué en vol). */
const TMP_ORPHELIN_MS = 5_000;

/** Version du format de persistance. */
export const BRAIN_VERSION = 2;

/** État complet du cerveau persisté. */
export interface BrainState {
  version: number;
  /** Date ISO de la sauvegarde. */
  sauvegardeLe: string;
  /** Configuration exacte du réseau (seed, densité, seuils...). */
  config: NeuralConfig;
  /** Synapses sérialisées compactes : [sourceId, targetId, weight]. */
  synapses: Array<[number, number, number]>;
  /** Registre inverse tokens { idNeurone → tokens } (encodage). */
  tokenRegistry: Record<number, string[]>;
  /** Historique des rapports d'entraînement (données réelles). */
  trainingHistory: TrainingReport[];
  /**
   * État du cortex langagier (v2) : paires personnalisées + poids d'usage.
   * Absent des cerveaux v1 — restauration optionnelle.
   */
  langage?: EtatLangage;
  /**
   * État de la couche d'ondes RPIA (poids [a, f, φ, d] × N + temps global).
   * Absent des cerveaux antérieurs au pont RPIA — restauration optionnelle :
   * sans elle, la couche repart de son état seedé (reprise dégradée, jamais
   * une erreur bloquante).
   */
  rpia?: EtatRPIA;
}

/**
 * Sauvegarde l'état du cerveau (non fatale en cas d'échec : console.warn).
 * Sérialisée par un mutex interne (aucune course entre appelants), avec
 * rotation `.bak` de la dernière version connue bonne.
 * @returns true si l'écriture a abouti.
 */
export function saveBrainState(
  reseau: ReseauNeuronalGen3,
  tokenRegistry: Record<number, string[]>,
  trainingHistory: TrainingReport[],
  langage?: EtatLangage,
  rpia?: EtatRPIA,
): Promise<boolean> {
  // Sérialisation : chaque écriture attend la fin de la précédente.
  fileDeSauvegarde = fileDeSauvegarde.then(() =>
    ecrireCerveauSansCourse(reseau, tokenRegistry, trainingHistory, langage, rpia),
  );
  // Jamais de rejet propagé : un échec de sauvegarde ne doit casser personne.
  return fileDeSauvegarde.catch(() => false);
}

async function ecrireCerveauSansCourse(
  reseau: ReseauNeuronalGen3,
  tokenRegistry: Record<number, string[]>,
  trainingHistory: TrainingReport[],
  langage?: EtatLangage,
  rpia?: EtatRPIA,
): Promise<boolean> {
  try {
    // Le répertoire var/ doit rester hors git (seul fichier hors lib/neural
    // que ce module touche — vérifié puis complété si nécessaire).
    await assurerVarDansGitignore();

    await fsp.mkdir(dirname(BRAIN_PATH), { recursive: true });

    const state: BrainState = {
      version: BRAIN_VERSION,
      sauvegardeLe: new Date().toISOString(),
      config: { ...reseau.config },
      synapses: reseau.synapses.map(
        (s) => [s.sourceId, s.targetId, s.weight] as [number, number, number],
      ),
      tokenRegistry,
      trainingHistory,
      ...(langage ? { langage } : {}),
      ...(rpia ? { rpia } : {}),
    };

    // Écriture atomique : .tmp UNIQUE (pid + uuid — deux sauvegardes
    // concurrentes ne partagent plus jamais le même fichier temporaire)
    // puis rename.
    const tmp = `${BRAIN_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(state), "utf8");
      // Rotation : la version courante (dernière connue bonne) est copiée
      // en .bak AVANT d'être remplacée — best effort, jamais bloquant.
      if (existsSync(BRAIN_PATH)) {
        try {
          await fsp.copyFile(BRAIN_PATH, BRAIN_BAK_PATH);
        } catch {
          // .bak indisponible : le rename reste sûr sans lui.
        }
      }
      await fsp.rename(tmp, BRAIN_PATH);
      // Auto-guérison : écrème les orphelins des process tués entre
      // writeFile et rename (worker terminé brutalement, OOM-kill…) —
      // dans la chaîne sérialisée, donc sans course avec la purge.
      await écrémerTmpOrphelins();
    } catch (erreur: unknown) {
      // Nettoyage du .tmp orphelin (jamais de déchet qui s'accumule).
      try {
        await fsp.unlink(tmp);
      } catch {
        // Déjà parti ou jamais créé — rien à faire.
      }
      throw erreur;
    }
    return true;
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL] Sauvegarde du cerveau impossible (non fatal) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
    return false;
  }
}

/**
 * ÉCRÉMAGE DES .TMP ORPHELINS — un process tué entre writeFile et rename
 * laisse un .tmp derrière lui. Chaque sauvegarde écrème best-effort les
 * .tmp périmés (> TMP_ORPHELIN_MS) du répertoire : jamais de déchet qui
 * s'accumule, sans jamais toucher à une écriture EN COURS (fraîche).
 */
async function écrémerTmpOrphelins(): Promise<void> {
  try {
    const dossier = dirname(BRAIN_PATH);
    const noms = await fsp.readdir(dossier);
    const limite = Date.now() - TMP_ORPHELIN_MS;
    await Promise.all(
      noms
        .filter((n) => n.endsWith(".tmp"))
        .map(async (n) => {
          const chemin = join(dossier, n);
          try {
            const stat = await fsp.stat(chemin);
            if (stat.mtimeMs < limite) await fsp.unlink(chemin);
          } catch {
            /* parti entre-temps : rien à faire */
          }
        }),
    );
  } catch {
    /* répertoire absent ou illisible : rien à écrémer */
  }
}

/**
 * Lecture défensive de l'état RPIA persisté : un état incomplet ou non
 * fini (poids NaN/Infinity, taille non entière) est rejeté en silencieux —
 * la couche repart alors de son état seedé (jamais d'erreur bloquante au
 * démarrage pour une télémétrie de résonance).
 */
function lireEtatRpiaDefensif(brut: unknown): EtatRPIA | undefined {
  if (!brut || typeof brut !== "object") return undefined;
  const etat = brut as Partial<EtatRPIA>;
  // Aligner les bornes du checkpoint sur celles de CoucheOndesNeuronales.
  const taille = etat.taille ?? 0;
  const pasTotaux = etat.pasTotaux;
  const tailleOk = Number.isInteger(taille) && taille >= 1 && taille <= 4096;
  const pasOk = Number.isInteger(pasTotaux) && (pasTotaux ?? -1) >= 0;
  // Un nœud possède exactement quatre paramètres [amplitude, fréquence,
  // phase, amortissement]. Une taille discordante doit faire rejeter l'état,
  // pas être reportée jusqu'à l'import dans le moteur au démarrage.
  const poidsOk =
    Array.isArray(etat.poids) &&
    etat.poids.length === taille * 4 &&
    etat.poids.every((v) => typeof v === "number" && Number.isFinite(v));
  if (!tailleOk || !pasOk || !poidsOk) return undefined;
  return {
    taille: etat.taille as number,
    pasTotaux: etat.pasTotaux as number,
    poids: etat.poids as number[],
  };
}

/**
 * Charge l'état du cerveau persisté (synchrone, appel unique au démarrage).
 * Durcissement 2026-10-22 : si le fichier principal est illisible, corrompu
 * ou invalide, la dernière version connue bonne (.bak) est tentée AVANT le
 * repli sur réseau neuf — une corruption ponctuelle ne coûte plus tout
 * l'apprentissage.
 * @returns L'état complet, ou null si absent/corrompu (repli silencieux sur
 *          un réseau neuf — un avertissement est loggé si corruption).
 */
export function loadBrainState(): BrainState | null {
  const principal = lireFichierCerveau(BRAIN_PATH);
  if (principal) return principal;
  if (existsSync(BRAIN_BAK_PATH)) {
    console.warn(
      "[NEURAL] Cerveau principal illisible — tentative sur la dernière version connue bonne (.bak)…",
    );
    const bak = lireFichierCerveau(BRAIN_BAK_PATH);
    if (bak) {
      console.warn(
        `[NEURAL] Cerveau restauré depuis .bak (sauvegardé le ${bak.sauvegardeLe}) — amnésie évitée.`,
      );
      return bak;
    }
  }
  return null;
}

/** Lit + valide un fichier de cerveau. null si absent/corrompu/invalide. */
function lireFichierCerveau(chemin: string): BrainState | null {
  try {
    if (!existsSync(chemin)) return null;
    const brut = readFileSync(chemin, "utf8");
    const etat = JSON.parse(brut) as Partial<BrainState>;
    if (
      !Array.isArray(etat.synapses) ||
      typeof etat.config !== "object" ||
      etat.config === null
    ) {
      console.warn(`[NEURAL] Fichier de cerveau invalide (${chemin}).`);
      return null;
    }
    return {
      version: typeof etat.version === "number" ? etat.version : BRAIN_VERSION,
      sauvegardeLe:
        typeof etat.sauvegardeLe === "string"
          ? etat.sauvegardeLe
          : new Date(0).toISOString(),
      config: etat.config,
      synapses: etat.synapses,
      tokenRegistry: etat.tokenRegistry ?? {},
      trainingHistory: Array.isArray(etat.trainingHistory)
        ? etat.trainingHistory
        : [],
      langage:
        etat.langage && typeof etat.langage === "object"
          ? {
              pairesPersonnalisees: Array.isArray(
                etat.langage.pairesPersonnalisees,
              )
                ? etat.langage.pairesPersonnalisees
                : [],
              poidsUsage:
                etat.langage.poidsUsage &&
                typeof etat.langage.poidsUsage === "object"
                  ? etat.langage.poidsUsage
                  : {},
            }
          : undefined,
      rpia: lireEtatRpiaDefensif(etat.rpia),
    };
  } catch (erreur: unknown) {
    console.warn(
      `[NEURAL] Lecture du cerveau impossible (${chemin}) :`,
      erreur instanceof Error ? erreur.message : String(erreur),
    );
    return null;
  }
}

/** Supprime le fichier de cerveau persisté (reset complet). Non fatale. */
export function deleteBrainState(): void {
  try {
    if (existsSync(BRAIN_PATH)) {
      unlinkSync(BRAIN_PATH);
    }
    if (existsSync(BRAIN_BAK_PATH)) {
      unlinkSync(BRAIN_BAK_PATH);
    }
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL] Suppression du cerveau impossible (non fatal) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
  }
}

/**
 * Vérifie que .gitignore contient une entrée `var/` (le cerveau persisté ne
 * doit jamais être committé) ; l'ajoute en fin de fichier sinon. Non fatale.
 */
async function assurerVarDansGitignore(): Promise<void> {
  try {
    const chemin = join(process.cwd(), ".gitignore");
    if (!existsSync(chemin)) {
      writeFileSync(
        chemin,
        "\n# État neuronal persistant (SNN)\nvar/\n",
        "utf8",
      );
      return;
    }
    const contenu = readFileSync(chemin, "utf8");
    if (!/(^|\n)\/?var\/(\n|$)/.test(contenu)) {
      const ecart = contenu.endsWith("\n") ? "" : "\n";
      writeFileSync(
        chemin,
        `${contenu}${ecart}# État neuronal persistant (SNN)\nvar/\n`,
        "utf8",
      );
    }
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL] Vérification .gitignore impossible (non fatal) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
  }
}
