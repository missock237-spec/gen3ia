/**
 * SYSTÈME D'EXPLOITATION D'OUTILS — portage fidèle de la classe
 * `SystemeExploitationOutils` de la source Python (Système d'Exploitation
 * d'Outils.pdf, cf. scripts/neural_reference/effectors_reference.py).
 *
 * Le Tool OS écoute le noyau : si le réseau résonne sur le canal
 * EXECUTER_OUTIL_OS (seuil 0.80) ET qu'une commande d'outil est fournie,
 * l'outil cible est exécuté dans un sandbox. Chaque exécution réelle met à
 * jour les métriques d'usage (utilisations, succès historique).
 *
 * Module PUR — aucune dépendance Node.
 */

import { POOL_EXECUTER_OUTIL_OS } from "../core/types";
import type { Effecteur, EffectorActionResult } from "../core/types";
import { actionEffecteur } from "../core/types";
import type { EspaceFiltreResonant } from "../core/resonant-space";

/** Nom du canal de sortie écouté (identique à la source). */
export const CANAL_EXECUTER_OUTIL_OS = "EXECUTER_OUTIL_OS";

/** Commande d'outil adressée au Tool OS (nom + arguments nommés). */
export interface CommandeOutil {
  nom: string;
  args?: Record<string, unknown>;
}

/** Entrée du registre d'outils : fonction exécutable + métriques d'usage. */
export interface OutilEnregistre {
  execute: (args: Record<string, unknown>) => unknown;
  description: string;
  utilisations: number;
  succesHistorique: number;
  /** Coût cumulé RÉELLEMENT mesuré des exécutions (ms) — métabolisme des effecteurs. */
  coutCumulMs: number;
  /** Durée de la dernière exécution mesurée (ms). */
  coutDernierMs: number;
}

/** Garde de type : une commande d'outil valide possède un `nom` string. */
function estCommandeOutil(valeur: unknown): valeur is CommandeOutil {
  if (typeof valeur !== "object" || valeur === null) return false;
  const candidate = valeur as { nom?: unknown; args?: unknown };
  if (typeof candidate.nom !== "string") return false;
  if (
    candidate.args !== undefined &&
    (typeof candidate.args !== "object" || candidate.args === null)
  ) {
    return false;
  }
  return true;
}

export class SystemeExploitationOutils implements Effecteur {
  readonly nom = "systeme_exploitation_outils";

  readonly espaceResonant: EspaceFiltreResonant;

  /** Contient les fonctions ou scripts exécutables enregistrés. */
  registreOutils: Map<string, OutilEnregistre>;

  /** Pool de sortie dédié au déclenchement d'outils par le noyau. */
  readonly outputPoolToolOs: readonly number[];

  constructor(espaceResonant: EspaceFiltreResonant) {
    this.espaceResonant = espaceResonant;
    this.registreOutils = new Map<string, OutilEnregistre>();
    this.outputPoolToolOs = POOL_EXECUTER_OUTIL_OS;

    // Pool de sortie dédié au déclenchement d'outils par le noyau
    this.espaceResonant.registerOutputPool(
      CANAL_EXECUTER_OUTIL_OS,
      [...this.outputPoolToolOs],
    );
  }

  /** Enregistre un nouvel outil dans le système d'exploitation de l'agent. */
  enregistrerOutil(
    nomOutil: string,
    fonctionExecutable: (args: Record<string, unknown>) => unknown,
    description = "",
  ): void {
    this.registreOutils.set(nomOutil, {
      execute: fonctionExecutable,
      description,
      utilisations: 0,
      succesHistorique: 1.0,
      coutCumulMs: 0,
      coutDernierMs: 0,
    });
    console.log(`[NEURAL] [Tool OS] Outil '${nomOutil}' enregistré et intégré au Corps Sémantique.`);
  }

  /**
   * Le Tool OS écoute le noyau. Si le réseau neuronal résonne sur le canal
   * d'exécution (≥ 0.80) ET qu'une commande valide est transmise dans le
   * contexte, l'outil cible est exécuté dans l'écosystème (sandbox).
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    commandeOutil?: CommandeOutil | Record<string, unknown>,
  ): EffectorActionResult[] {
    const scoreResonance = this.espaceResonant.readResonance(
      spikedNeurones,
      CANAL_EXECUTER_OUTIL_OS,
    );

    // Seuil de déclenchement validé par le noyau (ex: 80% d'activation)
    if (scoreResonance >= 0.8 && commandeOutil && estCommandeOutil(commandeOutil)) {
      const nomOutil = commandeOutil.nom;
      const argumentsOutil =
        (commandeOutil.args as Record<string, unknown> | undefined) ?? {};

      return this.executerEnSandbox(nomOutil, argumentsOutil);
    }

    return [];
  }

  /**
   * Exécution sécurisée (sandbox) d'un outil du registre.
   *  - outil introuvable → ECHEC (bug f-string de la source corrigé,
   *    adaptation (c) du portage) ;
   *  - succès → SUCCES + durée réelle + succesHistorique × 1.05 (cap 1.0) ;
   *  - exception → ECHEC + erreur + succesHistorique × 0.8 (plancher 0.1).
   */
  executerEnSandbox(
    nomOutil: string,
    args: Record<string, unknown>,
  ): EffectorActionResult[] {
    console.log(`[NEURAL] [Tool OS] Ordre d'exécution reçu du Noyau -> outil cible : ${nomOutil}`);

    const outilInfo = this.registreOutils.get(nomOutil);
    if (!outilInfo) {
      return [
        actionEffecteur(CANAL_EXECUTER_OUTIL_OS, "ECHEC", {
          details: `Outil '${nomOutil}' introuvable dans le Tool OS.`,
        }),
      ];
    }

    outilInfo.utilisations += 1;

    // MÉTABOLISME DES EFFECTEURS : la durée est mesurée pour TOUTE exécution
    // (succès comme échec) — un outil qui échoue coûte du temps réel aussi.
    const debutExec = Date.now();

    try {
      // Exécution sécurisée de la fonction de l'outil
      const resultatExecution = outilInfo.execute(args);
      const dureeMs = Date.now() - debutExec;

      // Mise à jour des métriques de succès
      outilInfo.succesHistorique = Math.min(
        1.0,
        outilInfo.succesHistorique * 1.05,
      );
      outilInfo.coutDernierMs = dureeMs;
      outilInfo.coutCumulMs += dureeMs;

      const feedback: EffectorActionResult = actionEffecteur(
        CANAL_EXECUTER_OUTIL_OS,
        "SUCCES",
        {
          outil: nomOutil,
          resultat: resultatExecution,
          dureeMs,
        },
      );
      console.log(
        `[NEURAL] [Tool OS] Exécution réussie en ${dureeMs}ms. Feedback positif renvoyé au noyau.`,
      );
      return [feedback];
    } catch (erreur: unknown) {
      const dureeMs = Date.now() - debutExec;
      outilInfo.succesHistorique = Math.max(
        0.1,
        outilInfo.succesHistorique * 0.8,
      );
      outilInfo.coutDernierMs = dureeMs;
      outilInfo.coutCumulMs += dureeMs;
      const message =
        erreur instanceof Error ? erreur.message : String(erreur);
      const feedback: EffectorActionResult = actionEffecteur(
        CANAL_EXECUTER_OUTIL_OS,
        "ECHEC",
        {
          outil: nomOutil,
          erreur: message,
          dureeMs,
        },
      );
      console.log(
        `[NEURAL] [Tool OS] Erreur lors de l'exécution : ${message}. Feedback négatif renvoyé au noyau.`,
      );
      return [feedback];
    }
  }
}
