/**
 * INTERFACE VOCALE & TÉLÉPHONIQUE — portage fidèle de la classe
 * `InterfaceVocaleTelephonique` de la source Python (l'Interface Vocale &
 * Téléphonique.pdf).
 *
 * L'interface vocale écoute le noyau : aucune action téléphonique n'est
 * engagée sans une résonance explicite du réseau neuronal (seuil 0.80) sur
 * l'un des quatre pools dédiés (initier / écouter / répondre / terminer).
 *
 * ADAPTATION HONNÊTE du portage (mode neuronal / test SNN) : la source
 * simulait les résultats (numéro fictif « +237XXXXXXX », transcription
 * fabriquée « Bonjour, je souhaite des informations. », confiance 0.95...).
 * Ici, les quatre actions retournent honnêtement MOTEUR_EXTERNE_DESACTIVE :
 * le STT, la synthèse vocale et la téléphonie Bland sont des moteurs externes
 * non connectés en mode neuronal. JAMAIS de faux numéros, JAMAIS de faux
 * appels, JAMAIS de transcription inventée — uniquement les paramètres
 * réellement demandés par l'appelant.
 *
 * Module PUR — aucune dépendance Node.
 */

import {
  POOL_INITIALISER_APPEL,
  POOL_ECOUTER_AUDIO,
  POOL_EMETTRE_REPONSE_VOCALE,
  POOL_TERMINER_APPEL,
} from "../core/types";
import type { Effecteur, EffectorActionResult } from "../core/types";
import { actionEffecteur } from "../core/types";
import type { EspaceFiltreResonant } from "../core/resonant-space";

/** Association action télécom ↔ pool de neurones de sortie. */
export interface ActionMappingTelecom {
  actionType: string;
  outputPool: readonly number[];
  description: string;
}

export class InterfaceVocaleTelephonique implements Effecteur {
  readonly nom = "interface_vocale_telephonique";

  readonly espaceResonant: EspaceFiltreResonant;

  /** Types d'actions et association avec les pools de sortie du Noyau. */
  readonly actionMappings: readonly ActionMappingTelecom[];

  constructor(espaceResonant: EspaceFiltreResonant) {
    this.espaceResonant = espaceResonant;

    // Définition des types d'actions et association avec les pools de
    // neurones de sortie du Noyau
    this.actionMappings = [
      {
        actionType: "INITIALISER_APPEL",
        outputPool: POOL_INITIALISER_APPEL,
        description: "Initie un appel téléphonique automatisé",
      },
      {
        actionType: "ECOUTER_AUDIO",
        outputPool: POOL_ECOUTER_AUDIO,
        description: "Analyse le flux sonore entrant",
      },
      {
        actionType: "EMETTRE_REPONSE_VOCALE",
        outputPool: POOL_EMETTRE_REPONSE_VOCALE,
        description: "Transmet une réponse vocale synthétisée",
      },
      {
        actionType: "TERMINER_APPEL",
        outputPool: POOL_TERMINER_APPEL,
        description: "Raccroche la ligne téléphonique",
      },
    ];

    // Enregistrement des pools de sortie dans l'espace résonant
    for (const config of this.actionMappings) {
      this.espaceResonant.registerOutputPool(
        config.actionType,
        [...config.outputPool],
      );
    }
  }

  /**
   * L'interface vocale écoute le noyau. Aucune action téléphonique n'est
   * engagée sans une résonance explicite du réseau neuronal (0.80).
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    parametresAppel?: Record<string, unknown>,
  ): EffectorActionResult[] {
    const actionsEffectuees: EffectorActionResult[] = [];

    for (const config of this.actionMappings) {
      const scoreResonance = this.espaceResonant.readResonance(
        spikedNeurones,
        config.actionType,
      );

      // Seuil de déclenchement du noyau (ex: 80% de coïncidence neuronale)
      if (scoreResonance >= 0.8) {
        const typeAction = config.actionType;
        const resultat = this.executerActionTelephonique(
          typeAction,
          parametresAppel,
        );

        // Feedback immédiat vers le noyau neuronal
        this.envoyerFeedbackAuNoyau(typeAction, resultat);

        actionsEffectuees.push(resultat);
      }
    }

    return actionsEffectuees;
  }

  /**
   * Exécution honnête d'une action téléphonique : les moteurs externes
   * (téléphonie Bland, STT, TTS) ne sont pas connectés en mode neuronal —
   * chaque action le déclare avec les paramètres réellement demandés.
   */
  private executerActionTelephonique(
    typeAction: string,
    parametres: Record<string, unknown> | undefined,
  ): EffectorActionResult {
    console.log(
      `[NEURAL] [Vocal & Téléphonique] Ordre reçu du Noyau -> action télécom : ${typeAction}`,
    );
    const params = parametres ?? {};

    if (typeAction === "INITIALISER_APPEL") {
      // JAMAIS de numéro fictif : seul le moteur externe est mentionné.
      return actionEffecteur(typeAction, "MOTEUR_EXTERNE_DESACTIVE", {
        details:
          "Moteur d'appels téléphoniques externe (Bland) non connecté en mode neuronal (test SNN).",
        parametresDemandes: params,
      });
    }

    if (typeAction === "ECOUTER_AUDIO") {
      // JAMAIS de transcription inventée : le STT externe est déconnecté.
      return actionEffecteur(typeAction, "MOTEUR_EXTERNE_DESACTIVE", {
        details:
          "Transcription vocale externe (STT) non connectée en mode neuronal (test SNN).",
        parametresDemandes: params,
      });
    }

    if (typeAction === "EMETTRE_REPONSE_VOCALE") {
      return actionEffecteur(typeAction, "MOTEUR_EXTERNE_DESACTIVE", {
        details:
          "Synthèse vocale externe non connectée en mode neuronal (test SNN).",
        parametresDemandes: params,
      });
    }

    if (typeAction === "TERMINER_APPEL") {
      return actionEffecteur(typeAction, "MOTEUR_EXTERNE_DESACTIVE", {
        details:
          "Aucune ligne téléphonique active : le moteur d'appels externe est non connecté en mode neuronal (test SNN).",
        parametresDemandes: params,
      });
    }

    return actionEffecteur(typeAction, "INCONNU", {
      details: "Commande télécom non reconnue.",
    });
  }

  /** Transduction de la réponse audio en signal d'entrée neuronal (log). */
  private envoyerFeedbackAuNoyau(
    typeAction: string,
    resultat: EffectorActionResult,
  ): void {
    console.log(
      `[NEURAL] [Feedback Vocal] Transduction de '${typeAction}' (status: ${resultat.status}) en signal d'entrée neuronal.`,
    );
  }
}
