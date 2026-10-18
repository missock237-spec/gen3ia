/**
 * EFFECTEUR DE GÉNÉRATION VISUELLE — portage fidèle de la classe
 * `EffecteurGenerationVisuelle` de la source Python (Génération Visuelle.pdf).
 *
 * L'effecteur visuel écoute le noyau : il ne s'active que si le réseau
 * atteint le seuil de résonance requis (0.80) pour une création graphique.
 * L'exécution passe par le Tool OS en sandbox — la mécanique (gating,
 * sandbox, métriques d'usage, feedback) est RÉELLE.
 *
 * ADAPTATION HONNÊTE du portage (mode neuronal / test SNN) : la source
 * simulait le rendu (fichier /tmp, score de cohérence fabriqué). Ici, le
 * moteur de rendu externe est déclaré NON CONNECTÉ : l'action interne
 * retourne explicitement { statut_rendu: "MOTEUR_EXTERNE_DESACTIVE", ... }
 * avec les paramètres réellement demandés (prompt, résolution). Aucun faux
 * fichier, aucun faux score.
 *
 * Module PUR — aucune dépendance Node.
 */

import { POOL_GENERER_IMAGE } from "../core/types";
import type { Effecteur, EffectorActionResult } from "../core/types";
import { actionEffecteur } from "../core/types";
import type { EspaceFiltreResonant } from "../core/resonant-space";
import type { SystemeExploitationOutils } from "./tool-os";
import { statutEffectifDuResultat } from "./audio";

/** Nom du canal de sortie écouté (identique à la source). */
export const CANAL_GENERER_IMAGE = "GENERER_IMAGE";

/** Paramètres visuels d'une commande de génération. */
export interface ParametresVisuels {
  prompt?: string;
  resolution?: string;
}

export class EffecteurGenerationVisuelle implements Effecteur {
  readonly nom = "effecteur_generation_visuelle";

  readonly espaceResonant: EspaceFiltreResonant;
  readonly toolOs: SystemeExploitationOutils;

  /** Pool de sortie dédié à la génération d'images commandée par le noyau. */
  readonly outputPoolVisuel: readonly number[];

  constructor(
    espaceResonant: EspaceFiltreResonant,
    toolOs: SystemeExploitationOutils,
  ) {
    this.espaceResonant = espaceResonant;
    this.toolOs = toolOs;

    // Pool de sortie dédié à la génération d'images commandée par le noyau
    this.outputPoolVisuel = POOL_GENERER_IMAGE;
    this.espaceResonant.registerOutputPool(
      CANAL_GENERER_IMAGE,
      [...this.outputPoolVisuel],
    );

    // Enregistrement de l'outil visuel directement dans le Tool OS de l'agent
    this.toolOs.enregistrerOutil(
      "generer_image_visuelle",
      (args) => this.actionGenerationInterne(args),
      "Génère un rendu visuel ou un motif graphique basé sur l'intention neuronale",
    );
  }

  /**
   * Action interne de génération — STUB HONNÊTE : le moteur de rendu visuel
   * externe n'est pas connecté en mode neuronal. Retourne le statut réel
   * (MOTEUR_EXTERNE_DESACTIVE) et les paramètres demandés, sans simuler de
   * fichier ni de score de cohérence.
   */
  private actionGenerationInterne(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const prompt =
      typeof args["prompt"] === "string" && args["prompt"].length > 0
        ? args["prompt"]
        : "Fractale neuronale abstraite";
    const resolution =
      typeof args["resolution"] === "string" && args["resolution"].length > 0
        ? args["resolution"]
        : "512x512";

    console.log(
      `[NEURAL] [Moteur Visuel] Moteur de rendu externe non connecté — intention visuelle : '${prompt}' (résolution: ${resolution})`,
    );

    return {
      statut_rendu: "MOTEUR_EXTERNE_DESACTIVE",
      details:
        "Moteur de rendu externe non connecté en mode neuronal (test SNN).",
      prompt,
      resolution,
    };
  }

  /**
   * L'effecteur visuel écoute le noyau. Il s'active uniquement si le réseau
   * atteint le seuil de résonance requis pour une création graphique (0.80).
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    parametresVisuels?: ParametresVisuels | Record<string, unknown>,
  ): EffectorActionResult[] {
    const scoreResonance = this.espaceResonant.readResonance(
      spikedNeurones,
      CANAL_GENERER_IMAGE,
    );

    // Seuil de déclenchement validé par le noyau (ex: 80% d'activation)
    if (scoreResonance >= 0.8) {
      const parametres: Record<string, unknown> = parametresVisuels
        ? { ...parametresVisuels }
        : { prompt: "Fractale neuronale abstraite", resolution: "512x512" };

      console.log(
        `[NEURAL] [Effecteur Visuel] Ordre validé par le Noyau Neuronal (score: ${scoreResonance.toFixed(2)}).`,
      );

      // Utilisation du Tool OS pour exécuter l'outil de manière sécurisée
      const resultats = this.toolOs.executerEnSandbox(
        "generer_image_visuelle",
        parametres,
      );

      // Retour du feedback au noyau pour modifier la plasticité synaptique
      this.envoyerFeedbackVisuelAuNoyau(resultats);

      // Re-typage honnête sur le canal visuel (cf. adaptation en tête de fichier).
      return resultats.map((resultat) =>
        actionEffecteur(
          CANAL_GENERER_IMAGE,
          statutEffectifDuResultat(resultat),
          {
            outil: resultat["outil"],
            dureeMs: resultat["dureeMs"],
            resultat: resultat["resultat"],
            scoreResonance,
            parametres,
          },
        ),
      );
    }

    return [];
  }

  /**
   * Convertit le succès ou l'échec de la génération en signal biologique
   * pour faire évoluer les connexions du cerveau (une ligne de log).
   */
  private envoyerFeedbackVisuelAuNoyau(
    resultats: EffectorActionResult[],
  ): void {
    for (const res of resultats) {
      if (res.status === "SUCCES") {
        console.log(
          "[NEURAL] [Feedback Visuel] Transduction positive : exécution sandbox réussie (moteur externe déconnecté).",
        );
      } else {
        console.log(
          "[NEURAL] [Feedback Visuel] Transduction négative : échec de l'exécution, ajustement des poids.",
        );
      }
    }
  }
}
