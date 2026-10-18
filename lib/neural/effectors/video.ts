/**
 * EFFECTEUR DE GÉNÉRATION VIDÉO — portage fidèle de la classe
 * `EffecteurGenerationVideo` de la source Python (l'Effecteur de Génération
 * Vidéo.pdf).
 *
 * L'effecteur vidéo écoute le noyau : il ne s'active que si le réseau
 * atteint le seuil de résonance requis (0.80) pour une création animée.
 * L'exécution passe par le Tool OS en sandbox — la mécanique (gating,
 * sandbox, métriques d'usage, feedback) est RÉELLE.
 *
 * ADAPTATION HONNÊTE du portage (mode neuronal / test SNN) : la source
 * simulait le rendu des trames (fichier /tmp, score de fluidité fabriqué).
 * Ici, le moteur de rendu externe est déclaré NON CONNECTÉ : l'action interne
 * retourne explicitement { statut_rendu: "MOTEUR_EXTERNE_DESACTIVE", ... }
 * avec les paramètres réellement demandés (prompt, durée, fps). Aucun faux
 * fichier, aucun faux score.
 *
 * Module PUR — aucune dépendance Node.
 */

import { POOL_GENERER_VIDEO } from "../core/types";
import type { Effecteur, EffectorActionResult } from "../core/types";
import { actionEffecteur } from "../core/types";
import type { EspaceFiltreResonant } from "../core/resonant-space";
import type { SystemeExploitationOutils } from "./tool-os";
import { statutEffectifDuResultat } from "./audio";

/** Nom du canal de sortie écouté (identique à la source). */
export const CANAL_GENERER_VIDEO = "GENERER_VIDEO";

/** Paramètres vidéo d'une commande de génération. */
export interface ParametresVideo {
  prompt?: string;
  duree_secondes?: number;
  fps?: number;
}

export class EffecteurGenerationVideo implements Effecteur {
  readonly nom = "effecteur_generation_video";

  readonly espaceResonant: EspaceFiltreResonant;
  readonly toolOs: SystemeExploitationOutils;

  /** Pool de sortie dédié à la génération vidéo commandée par le noyau. */
  readonly outputPoolVideo: readonly number[];

  constructor(
    espaceResonant: EspaceFiltreResonant,
    toolOs: SystemeExploitationOutils,
  ) {
    this.espaceResonant = espaceResonant;
    this.toolOs = toolOs;

    // Pool de sortie dédié à la génération vidéo commandée par le noyau
    this.outputPoolVideo = POOL_GENERER_VIDEO;
    this.espaceResonant.registerOutputPool(
      CANAL_GENERER_VIDEO,
      [...this.outputPoolVideo],
    );

    // Enregistrement de l'outil vidéo dans le Tool OS de l'agent
    this.toolOs.enregistrerOutil(
      "generer_sequence_video",
      (args) => this.actionGenerationVideoInterne(args),
      "Génère une séquence vidéo ou une animation temporelle basée sur l'intention neuronale",
    );
  }

  /**
   * Action interne de génération — STUB HONNÊTE : le moteur de rendu vidéo
   * externe n'est pas connecté en mode neuronal. Retourne le statut réel
   * (MOTEUR_EXTERNE_DESACTIVE) et les paramètres demandés, sans simuler de
   * fichier ni de score de fluidité.
   */
  private actionGenerationVideoInterne(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const prompt =
      typeof args["prompt"] === "string" && args["prompt"].length > 0
        ? args["prompt"]
        : "Transition fluide de structures neuronales";
    const dureeSecondes =
      typeof args["duree_secondes"] === "number" ? args["duree_secondes"] : 4;
    const fps = typeof args["fps"] === "number" ? args["fps"] : 24;

    console.log(
      `[NEURAL] [Moteur Vidéo] Moteur de rendu externe non connecté — intention vidéo : '${prompt}' (${dureeSecondes}s à ${fps}fps)`,
    );

    return {
      statut_rendu: "MOTEUR_EXTERNE_DESACTIVE",
      details:
        "Moteur de rendu externe non connecté en mode neuronal (test SNN).",
      prompt,
      duree: dureeSecondes,
      fps,
    };
  }

  /**
   * L'effecteur vidéo écoute le noyau. Il s'active uniquement si le réseau
   * atteint le seuil de résonance requis pour une création animée (0.80).
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    parametresVideo?: ParametresVideo | Record<string, unknown>,
  ): EffectorActionResult[] {
    const scoreResonance = this.espaceResonant.readResonance(
      spikedNeurones,
      CANAL_GENERER_VIDEO,
    );

    // Seuil de déclenchement validé par le noyau (ex: 80% d'activation)
    if (scoreResonance >= 0.8) {
      const parametres: Record<string, unknown> = parametresVideo
        ? { ...parametresVideo }
        : { prompt: "Transition fluide de structures neuronales", duree_secondes: 4 };

      console.log(
        `[NEURAL] [Effecteur Vidéo] Ordre validé par le Noyau Neuronal (score: ${scoreResonance.toFixed(2)}).`,
      );

      // Utilisation du Tool OS pour exécuter l'outil vidéo en sandbox
      const resultats = this.toolOs.executerEnSandbox(
        "generer_sequence_video",
        parametres,
      );

      // Retour du feedback vidéo au noyau pour modifier la plasticité synaptique
      this.envoyerFeedbackVideoAuNoyau(resultats);

      // Re-typage honnête sur le canal vidéo (cf. adaptation en tête de fichier).
      return resultats.map((resultat) =>
        actionEffecteur(
          CANAL_GENERER_VIDEO,
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
   * Convertit le succès ou l'échec de l'animation en signal biologique pour
   * faire évoluer les connexions du cerveau (une ligne de log).
   */
  private envoyerFeedbackVideoAuNoyau(
    resultats: EffectorActionResult[],
  ): void {
    for (const res of resultats) {
      if (res.status === "SUCCES") {
        console.log(
          "[NEURAL] [Feedback Vidéo] Transduction positive : exécution sandbox réussie (moteur externe déconnecté).",
        );
      } else {
        console.log(
          "[NEURAL] [Feedback Vidéo] Transduction négative : échec du rendu, ajustement des poids synaptiques.",
        );
      }
    }
  }
}
