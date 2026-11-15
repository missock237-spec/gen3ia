import "server-only";

import { CoucheOndesNeuronales } from "@/lib/neural/core/couche-rpia";
import { hachagePrompt } from "@/lib/ondes/conditionneur";

/**
 * PONT SYMBOLIQUE RPIA → PROMPT DE CHAT (couche A-P0 du plan d'amélioration).
 *
 * RÔLE PRÉCIS (sans doublon) : la couche PHYSIQUE RPIA est déjà branchée au
 * cœur du moteur neuronal — `lib/neural/engine.ts` résonne chaque message
 * utilisateur (couche-rpia.resonnerVersTexte) et FUSIONNE les énergies
 * d'interférence dans les entrées des cycles neuronaux (fusionnerEnergies).
 * Ce module ne refait PAS ce travail : il produit la couche LINGUISTIQUE —
 * le profil de résonance MESURÉ (erreur de convergence, dispersion des
 * énergies, nœuds actifs) est converti en DIRECTIVES DÉTERMINISTES injectées
 * dans le prompt système structuré du chat (lib/agents/chat-engine.ts).
 *
 * HONNÊTETÉ : chaque directive dérive d'une grandeur réellement mesurée par
 * la physique de la couche (même miroir CPU déterministe que la route
 * app/api/ondes/rpia). Aucune valeur inventée : si la mesure dit « pas de
 * convergence », le prompt demande de clarifier l'ambiguïté ; si la mesure
 * dit « énergie dispersée sur plusieurs pics », le prompt demande une
 * réponse structurée par sections.
 *
 * FAIL-SOFT TOTAL (doctrine du chat) : ce module NE LÈVE JAMAIS. Une panne
 * de la couche RPIA rend `null` et le chat répond sans modulation — exactement
 * comme twinDirectiveForUser pour le jumeau. Latence bornée : couche de 64
 * nœuds, 8 époques maximum (calcul déterministe O(nœuds × époques), < 1 ms).
 */

/** Taille de la couche de résonance dédiée au chat (nœuds = neurones couverts). */
const TAILLE_COUCHE_CHAT = 64;

/** Époques bornées — le tour de chat ne doit jamais attendre l'entraînement. */
const EPOQUES_CHAT = 8;

/** Télémétrie honnête du conditionnement (mesurée, jamais estimée). */
export interface TelemetrieConditionnementRPIA {
  /** Nombre de nœuds d'onde de la couche chat. */
  noeuds: number;
  /** Époques réellement exécutées. */
  epoques: number;
  /** Erreur d'interférence moyenne avant le premier pas. */
  erreurInitiale: number;
  /** Erreur d'interférence moyenne après le dernier pas. */
  erreurFinale: number;
  /** Progrès réel : erreur finale < erreur initiale. */
  convergence: boolean;
  /** Énergie moyenne des nœuds (grandeur mesurée de la couche). */
  energieMoyenne: number;
  /** Dispersion relative (écart-type / moyenne) — 0 = énergie concentrée. */
  dispersion: number;
  /** Nœuds au-dessus de la moyenne (pics de résonance). */
  noeudsActifs: number;
}

/** Résultat du pont symbolique : directives prêtes pour le prompt structuré. */
export interface ConditionnementRPIA {
  /** Directives en français, injectées comme contraintes du prompt système. */
  directives: string[];
  /** Mesures réelles qui ont produit ces directives. */
  telemetrie: TelemetrieConditionnementRPIA;
}

/**
 * Résonne la requête utilisateur dans une couche RPIA dédiée au chat et
 * convertit le profil mesuré en directives de réponse. Déterministe : la
 * même (conversation, message) produit exactement le même conditionnement.
 *
 * @param message texte de la requête utilisateur (non vide).
 * @param graine  graine déterministe — recommandé : hachagePrompt(`${userId}:${message}`).
 * @returns le conditionnement, ou `null` si la couche est indisponible
 *          (le chat continue SANS modulation — jamais de blocage).
 */
export function conditionnerRequeteRPIA(
  message: string,
  graine: number,
): ConditionnementRPIA | null {
  try {
    if (typeof message !== "string" || message.trim().length === 0) return null;

    const couche = new CoucheOndesNeuronales(TAILLE_COUCHE_CHAT, { graine });
    const { rapport, energies } = couche.resonnerVersTexte(message, EPOQUES_CHAT);

    // Statistiques RÉELLES du profil d'énergie produit par la résonance.
    const valeurs = Object.values(energies);
    if (valeurs.length === 0) return null;
    const moyenne = valeurs.reduce((somme, e) => somme + Math.abs(e), 0) / valeurs.length;
    if (moyenne <= 0) return null;
    const variance =
      valeurs.reduce((somme, e) => somme + (Math.abs(e) - moyenne) ** 2, 0) / valeurs.length;
    const dispersion = Math.sqrt(variance) / moyenne;
    const noeudsActifs = valeurs.filter((e) => Math.abs(e) > moyenne).length;
    const ratioActifs = noeudsActifs / valeurs.length;

    const telemetrie: TelemetrieConditionnementRPIA = {
      noeuds: couche.taille,
      epoques: rapport.epoques,
      erreurInitiale: rapport.erreurInitiale,
      erreurFinale: rapport.erreurFinale,
      convergence: rapport.convergence,
      energieMoyenne: moyenne,
      dispersion,
      noeudsActifs,
    };

    // MAPPING DÉTERMINISTE mesure → directive (1 à 3 directives, jamais plus).
    const directives: string[] = [];

    if (!rapport.convergence || rapport.erreurFinale > 0.9 * rapport.erreurInitiale) {
      directives.push(
        "Modulation RPIA : la résonance de la requête n'a pas convergé — la demande est probablement ambiguë ; commence par reformuler l'objectif compris, puis réponds prudemment en signalant les hypothèses.",
      );
    } else if (dispersion > 0.35) {
      directives.push(
        "Modulation RPIA : énergie dispersée sur plusieurs pics — la requête porte plusieurs axes ; structure la réponse en sections courtes avec un titre par axe.",
      );
    } else if (dispersion < 0.15) {
      directives.push(
        "Modulation RPIA : énergie concentrée sur un axe dominant — va droit au but, réponse resserrée sans développement superflu.",
      );
    } else {
      directives.push(
        "Modulation RPIA : profil équilibré — un cœur de réponse direct, appuyé par un ou deux détails pertinents.",
      );
    }

    if (ratioActifs > 0.7) {
      directives.push(
        "Modulation RPIA : forte proportion de nœuds actifs — la demande est riche ; traite aussi les points secondaires pertinents au-delà du cœur.",
      );
    }

    return { directives, telemetrie };
  } catch {
    // Fail-soft total : la couche RPIA ne doit JAMAIS bloquer un tour de chat.
    return null;
  }
}

/**
 * Graine déterministe pour un tour de chat précis (cohérence : le même
 * message dans la même conversation résonne toujours pareil).
 */
export function graineTourChat(userId: string, message: string): number {
  return hachagePrompt(`${userId}:${message}`);
}
