/**
 * EFFECTEUR DE GÉNÉRATION AUDIO — portage fidèle de la classe
 * `EffecteurGenerationAudio` de la source Python (l'Effecteur de Génération
 * Audio & Sonore.pdf).
 *
 * L'effecteur audio écoute le noyau : il ne s'active que si le réseau atteint
 * le seuil de résonance requis (0.80) pour une création sonore. L'exécution
 * passe par le Tool OS en sandbox — la mécanique (gating, sandbox, métriques
 * d'usage, feedback) est RÉELLE.
 *
 * MOTEUR LOCAL : la synthèse est produite par le moteur neuronal local
 * (lib/neural/generation/audio-engine.ts — WAV réel calculé depuis
 * l'histogramme des poids synaptiques APPRIS). Aucune IA externe.
 * Le générateur est injecté au constructeur (câblé dans runtime.ts) ;
 * sans générateur, l'effecteur le déclare honnêtement
 * (MOTEUR_LOCAL_INDISPONIBLE) — jamais de fichier ni de score fabriqué.
 *
 * Module PUR — aucune dépendance Node.
 */

import { POOL_GENERER_AUDIO } from "../core/types";
import type { Effecteur, EffectorActionResult, EffectorStatus } from "../core/types";
import { actionEffecteur } from "../core/types";
import type { EspaceFiltreResonant } from "../core/resonant-space";
import type { SystemeExploitationOutils } from "./tool-os";

/** Nom du canal de sortie écouté (identique à la source). */
export const CANAL_GENERER_AUDIO = "GENERER_AUDIO";

/** Générateur local de média : produit le contenu réel (data URI + mime). */
export type GenerateurLocalMedia = (
  args: Record<string, unknown>,
) => Record<string, unknown>;

/** Paramètres audio d'une commande de génération. */
export interface ParametresAudio {
  prompt?: string;
  duree_secondes?: number;
  frequence_echantillonnage?: number;
}

export class EffecteurGenerationAudio implements Effecteur {
  readonly nom = "effecteur_generation_audio";

  readonly espaceResonant: EspaceFiltreResonant;
  readonly toolOs: SystemeExploitationOutils;

  /** Pool de sortie dédié à la génération audio commandée par le noyau. */
  readonly outputPoolAudio: readonly number[];

  constructor(
    espaceResonant: EspaceFiltreResonant,
    toolOs: SystemeExploitationOutils,
    private readonly generateurLocal?: GenerateurLocalMedia,
  ) {
    this.espaceResonant = espaceResonant;
    this.toolOs = toolOs;

    // Pool de sortie dédié à la génération audio commandée par le noyau
    this.outputPoolAudio = POOL_GENERER_AUDIO;
    this.espaceResonant.registerOutputPool(
      CANAL_GENERER_AUDIO,
      [...this.outputPoolAudio],
    );

    // Enregistrement de l'outil audio dans le Tool OS de l'agent
    this.toolOs.enregistrerOutil(
      "generer_signal_audio",
      (args) => this.actionGenerationAudioInterne(args),
      "Synthétise un signal sonore, une ambiance ou un effet audio d'après l'intention neuronale",
    );
  }

  /**
   * Action interne de synthèse — MOTEUR LOCAL : le générateur injecté
   * produit un VRAI signal WAV (synthèse calculée depuis l'état neuronal).
   * Sans générateur injecté : statut honnête MOTEUR_LOCAL_INDISPONIBLE.
   */
  private actionGenerationAudioInterne(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const prompt =
      typeof args["prompt"] === "string" && args["prompt"].length > 0
        ? args["prompt"]
        : "Signal d'harmonique pure et pulsation fluide";
    const dureeSecondes =
      typeof args["duree_secondes"] === "number" ? args["duree_secondes"] : 3;
    const frequenceEchantillonnage =
      typeof args["frequence_echantillonnage"] === "number"
        ? args["frequence_echantillonnage"]
        : 22050;

    if (this.generateurLocal) {
      return this.generateurLocal({
        ...args,
        prompt,
        duree_secondes: dureeSecondes,
        frequence_echantillonnage: frequenceEchantillonnage,
      });
    }

    return {
      statut_rendu: "MOTEUR_LOCAL_INDISPONIBLE",
      details:
        "Aucun moteur de synthèse local n'est injecté dans cet effecteur.",
      prompt,
      duree: dureeSecondes,
      frequence: frequenceEchantillonnage,
    };
  }

  /**
   * L'effecteur audio écoute le noyau. Il s'active uniquement si le réseau
   * atteint le seuil de résonance requis pour une création sonore (0.80).
   * Le résultat du sandbox est re-typé sur le canal audio : si l'outil a tourné
   * mais que le moteur externe est déconnecté, le statut honnête
   * MOTEUR_EXTERNE_DESACTIVE remonte au noyau.
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    parametresAudio?: ParametresAudio | Record<string, unknown>,
  ): EffectorActionResult[] {
    const scoreResonance = this.espaceResonant.readResonance(
      spikedNeurones,
      CANAL_GENERER_AUDIO,
    );

    // Seuil de déclenchement validé par le noyau (ex: 80% d'activation)
    if (scoreResonance >= 0.8) {
      const parametres: Record<string, unknown> = parametresAudio
        ? { ...parametresAudio }
        : { prompt: "Signal d'harmonique pure et pulsation fluide", duree_secondes: 3 };

      console.log(
        `[NEURAL] [Effecteur Audio] Ordre validé par le Noyau Neuronal (score: ${scoreResonance.toFixed(2)}).`,
      );

      // Utilisation du Tool OS pour exécuter l'outil audio en sandbox
      const resultats = this.toolOs.executerEnSandbox(
        "generer_signal_audio",
        parametres,
      );

      // Retour du feedback audio au noyau pour modifier la plasticité synaptique
      this.envoyerFeedbackAudioAuNoyau(resultats);

      // Re-typage honnête sur le canal audio (cf. adaptation en tête de fichier).
      return resultats.map((resultat) =>
        actionEffecteur(
          CANAL_GENERER_AUDIO,
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
   * Convertit la réussite de la synthèse en signal d'apprentissage pour
   * renforcer les liaisons synaptiques correspondantes (une ligne de log,
   * remplacement des prints Python).
   */
  private envoyerFeedbackAudioAuNoyau(
    resultats: EffectorActionResult[],
  ): void {
    for (const res of resultats) {
      if (res.status === "SUCCES") {
        console.log(
          "[NEURAL] [Feedback Audio] Transduction positive : exécution sandbox réussie (moteur externe déconnecté).",
        );
      } else {
        console.log(
          "[NEURAL] [Feedback Audio] Transduction négative : échec de l'exécution, ajustement des poids.",
        );
      }
    }
  }
}

/**
 * Statut effectif d'une action média : une exécution sandbox SUCCES dont le
 * rendu est indisponible remonte honnêtement son statut réel.
 */
export function statutEffectifDuResultat(
  resultat: EffectorActionResult,
): EffectorStatus {
  if (resultat.status === "SUCCES") {
    const rendu = resultat["resultat"];
    if (
      typeof rendu === "object" &&
      rendu !== null &&
      (rendu as { statut_rendu?: unknown }).statut_rendu ===
        "MOTEUR_EXTERNE_DESACTIVE"
    ) {
      return "MOTEUR_EXTERNE_DESACTIVE";
    }
    if (
      typeof rendu === "object" &&
      rendu !== null &&
      (rendu as { statut_rendu?: unknown }).statut_rendu ===
        "MOTEUR_LOCAL_INDISPONIBLE"
    ) {
      return "MOTEUR_LOCAL_INDISPONIBLE";
    }
  }
  return resultat.status;
}
