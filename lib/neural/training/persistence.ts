import "server-only";

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

import type { ReseauNeuronalGen3 } from "../core/network";
import type { NeuralConfig } from "../core/types";
import type { TrainingReport } from "./trainer";

/**
 * PERSISTANCE DU CERVEAU NEURONAL — état structural (config + synapses) et
 * mémoire lexicale (registre de tokens), écrits dans var/neural/brain-v1.json
 * (hors git, cf. .gitignore).
 *
 * Garanties :
 *  - écriture ATOMIQUE (fichier .tmp + rename) : un crash en cours d'écriture
 *    ne peut jamais corrompre le cerveau précédent ;
 *  - échec NON FATAL : la sauvegarde/lecture rate doucement (console.warn /
 *    retour null) — le système repart sur un réseau seedé neuf ;
 *  - loadBrainState est SYNCHRONE : appelé une unique fois au démarrage du
 *    runtime (getNeuralRuntime), avant tout cycle — le coût est négligeable.
 */

/** Chemin canonique du fichier de cerveau persisté. */
export const BRAIN_PATH = join(process.cwd(), "var/neural/brain-v1.json");

/** Version du format de persistance. */
export const BRAIN_VERSION = 1;

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
}

/**
 * Sauvegarde l'état du cerveau (non fatale en cas d'échec : console.warn).
 * @returns true si l'écriture a abouti.
 */
export async function saveBrainState(
  reseau: ReseauNeuronalGen3,
  tokenRegistry: Record<number, string[]>,
  trainingHistory: TrainingReport[],
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
    };

    // Écriture atomique : .tmp puis rename.
    const tmp = `${BRAIN_PATH}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state), "utf8");
    await fsp.rename(tmp, BRAIN_PATH);
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
 * Charge l'état du cerveau persisté (synchrone, appel unique au démarrage).
 * @returns L'état complet, ou null si absent/corrompu (repli silencieux sur
 *          un réseau neuf — un avertissement est loggé si corruption).
 */
export function loadBrainState(): BrainState | null {
  try {
    if (!existsSync(BRAIN_PATH)) return null;
    const brut = readFileSync(BRAIN_PATH, "utf8");
    const etat = JSON.parse(brut) as Partial<BrainState>;
    if (
      !Array.isArray(etat.synapses) ||
      typeof etat.config !== "object" ||
      etat.config === null
    ) {
      console.warn("[NEURAL] Fichier de cerveau invalide — réseau neuf seedé.");
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
    };
  } catch (erreur: unknown) {
    console.warn(
      "[NEURAL] Lecture du cerveau impossible (réseau neuf seedé) :",
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
