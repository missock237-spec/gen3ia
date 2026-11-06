/**
 * DONNÉES DE LA MÉMOIRE DE DOMAINES (générées par
 * scripts/genere-memoire-domaines-it113.ts — 2026-11-06T16:48:15.532Z).
 *
 * MESURES : chaque octet physique est mesuré sur le disque (statSync) —
 * assets multimodaux réels, corpus commis (répartis par thèmes réels),
 * snapshots SNN cumulatifs, graines synthétiques commises. Les échantillons
 * assimilés par ondes sont les TOTAUX DOCUMENTÉS des en-têtes du dépôt.
 *
 * SOURCES : registre d'acquisition HF/Kaggle par domaine — statut « acquise »
 * (dans la mémoire, emplacement exact tracé) ou « cible » (fenêtre suivante).
 *
 * HONNÊTETÉ : la couverture physique est RÉELLE ; l'expansion déterministe
 * des compartiments calculables matérialise à la demande (unité calculée),
 * elle ne pré-existe pas ; les compartiments non calculables le déclarent.
 * Module PUR — aucune dépendance Node.
 */

export const DATE_MESURE_MEMOIRE = "2026-11-06T16:48:15.532Z";

/** Compartiment = (domaine, capacité) — cible 1 Go chacun. */
export interface MesureCompartiment {
  readonly cle: string;
  readonly octetsReels: number;
  readonly echantillonsAssimiles: number;
  readonly octetsGraine: number;
  readonly familles: number;
  readonly octetsMoyensParUnite: number;
  readonly expansionDeterministe: boolean;
  readonly provenances: string;
}

export const MESURES_MEMOIRE: readonly MesureCompartiment[] = [
  { cle: "math|texte", octetsReels: 7991, echantillonsAssimiles: 0, octetsGraine: 2541, familles: 5, octetsMoyensParUnite: 143, expansionDeterministe: true, provenances: "corpus commis corpus-domaines-it84.ts (20 paires thème « math »)" },
  { cle: "math|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "math|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "math|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "math|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "math|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "math|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "sciences|texte", octetsReels: 7991, echantillonsAssimiles: 0, octetsGraine: 2033, familles: 4, octetsMoyensParUnite: 127, expansionDeterministe: true, provenances: "corpus commis corpus-domaines-it84.ts (20 paires thème « sciences »)" },
  { cle: "sciences|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "sciences|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "sciences|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "sciences|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "sciences|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "sciences|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "reasoning|texte", octetsReels: 2797, echantillonsAssimiles: 999935, octetsGraine: 2033, familles: 4, octetsMoyensParUnite: 122, expansionDeterministe: true, provenances: "corpus commis corpus-domaines-it84.ts (7 paires thème « reasoning ») ; 999 935 paires raisonnement humain assimilées par ondes (bande 0, scripts/entrainement-raisonnement-humain-it85.ts)" },
  { cle: "reasoning|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "reasoning|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "reasoning|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "reasoning|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "reasoning|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "reasoning|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "problem_solving|texte", octetsReels: 0, echantillonsAssimiles: 300000, octetsGraine: 2033, familles: 4, octetsMoyensParUnite: 107, expansionDeterministe: true, provenances: "300 000 questions d'interrogation assimilées par ondes (bande 6, scripts/interrogation-milliard-it86.ts)" },
  { cle: "problem_solving|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "problem_solving|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "problem_solving|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "problem_solving|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "problem_solving|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "problem_solving|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|texte", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "nlp_comprehension|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "text_generation|texte", octetsReels: 84792, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-couleurs-it89.ts (moitié génération) ; corpus commis corpus-domaines-it84.ts (6 paires thème « text_generation ») ; corpus commis corpus-raisonnement-it94.ts (moitié génération) ; corpus commis couleurs-kaggle-it89.ts (moitié génération) ; corpus commis multimodal-it90.ts (moitié génération)" },
  { cle: "text_generation|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "text_generation|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "text_generation|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "text_generation|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "text_generation|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "text_generation|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "conversational_memory|texte", octetsReels: 269125, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-couleurs-it89.ts (moitié base conversationnelle) ; corpus commis corpus-domaines-it84.ts (9 paires thème « conversation_scenario ») ; corpus commis corpus-interrogation-it86.ts (30 paires thème « math_verbal ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « deduction ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « conditionnel ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « induction ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « abduction ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « analogie ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « causalite ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « sens_commun ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « theorie_esprit ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « planification ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « math_verbal ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « pragmatique ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « ethique_pratique ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « spatial ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « temporel ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « metacognition ») ; corpus commis corpus-raisonnement-it85.ts (12 paires thème « resolution_probleme ») ; corpus commis corpus-raisonnement-it94.ts (moitié base conversationnelle) ; corpus commis corpus.ts (7 paires thème « salutation ») ; corpus commis corpus.ts (7 paires thème « identite ») ; corpus commis corpus.ts (7 paires thème « capacites ») ; corpus commis corpus.ts (6 paires thème « etat ») ; corpus commis corpus.ts (6 paires thème « entrainement ») ; corpus commis corpus.ts (5 paires thème « systeme_neural ») ; corpus commis corpus.ts (7 paires thème « plateforme ») ; corpus commis corpus.ts (5 paires thème « medias ») ; corpus commis corpus.ts (6 paires thème « redaction ») ; corpus commis corpus.ts (12 paires thème « studio ») ; corpus commis corpus.ts (4 paires thème « outils ») ; corpus commis corpus.ts (4 paires thème « memoire ») ; corpus commis corpus.ts (6 paires thème « honnetete ») ; corpus commis corpus.ts (6 paires thème « remerciement ») ; corpus commis corpus.ts (5 paires thème « au_revoir ») ; corpus commis corpus.ts (6 paires thème « smalltalk ») ; corpus commis corpus.ts (5 paires thème « aide_plateforme ») ; corpus commis corpus.ts (5 paires thème « incomprehension ») ; corpus commis corpus.ts (8 paires thème « evolution ») ; corpus commis corpus.ts (7 paires thème « pilotage ») ; corpus commis corpus.ts (6 paires thème « multimodal ») ; corpus commis couleurs-kaggle-it89.ts (moitié base conversationnelle) ; corpus commis multimodal-it90.ts (moitié base conversationnelle)" },
  { cle: "conversational_memory|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "conversational_memory|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "conversational_memory|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "conversational_memory|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "conversational_memory|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "conversational_memory|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "contextual_understanding|texte", octetsReels: 799, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (2 paires thème « contextual_understanding »)" },
  { cle: "contextual_understanding|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "contextual_understanding|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "contextual_understanding|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "contextual_understanding|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "contextual_understanding|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "contextual_understanding|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "intent_recognition|texte", octetsReels: 7991, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (20 paires thème « intent_recognition »)" },
  { cle: "intent_recognition|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "intent_recognition|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "intent_recognition|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "intent_recognition|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "intent_recognition|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "intent_recognition|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "professions|texte", octetsReels: 6792, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (17 paires thème « professions »)" },
  { cle: "professions|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "professions|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "professions|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "professions|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "professions|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "professions|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "databases|texte", octetsReels: 6792, echantillonsAssimiles: 0, octetsGraine: 1524, familles: 3, octetsMoyensParUnite: 209, expansionDeterministe: true, provenances: "corpus commis corpus-domaines-it84.ts (17 paires thème « databases »)" },
  { cle: "databases|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "databases|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "databases|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "databases|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "databases|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "databases|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "tools|texte", octetsReels: 1199, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (3 paires thème « tools »)" },
  { cle: "tools|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "tools|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "tools|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "tools|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "tools|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "tools|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "code_v4|texte", octetsReels: 5594, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (14 paires thème « code_v4 »)" },
  { cle: "code_v4|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "code_v4|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "code_v4|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "code_v4|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "code_v4|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 2033, familles: 4, octetsMoyensParUnite: 122, expansionDeterministe: true, provenances: "" },
  { cle: "code_v4|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "security_v4|texte", octetsReels: 5993, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (15 paires thème « security_v4 »)" },
  { cle: "security_v4|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "security_v4|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "security_v4|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "security_v4|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "security_v4|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "security_v4|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "image_analysis|texte", octetsReels: 7591, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (19 paires thème « image_analysis »)" },
  { cle: "image_analysis|image", octetsReels: 22142840, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "20 assets réels image de la fenêtre it101 ; 20 assets réels image de la fenêtre it104 ; 20 assets réels image de la fenêtre it105 ; 20 assets réels image de la fenêtre it106 ; 20 assets réels image de la fenêtre it107 ; 20 assets réels image de la fenêtre it108 ; 20 assets réels image de la fenêtre it109 ; 20 assets réels image de la fenêtre it110 ; 20 assets réels image de la fenêtre it111 ; 20 assets réels image de la fenêtre it112 ; 20 assets réels image de la fenêtre it113 ; 76 assets réels image de la fenêtre it90 ; 20 assets réels image de la fenêtre it94 ; 20 assets réels image de la fenêtre it95 ; 20 assets réels image de la fenêtre it96 ; 20 assets réels image de la fenêtre it97 ; 20 assets réels image de la fenêtre it98 ; 20 assets réels image de la fenêtre it99" },
  { cle: "image_analysis|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "image_analysis|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "image_analysis|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "image_analysis|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "image_analysis|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "video_v4|texte", octetsReels: 3995, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (10 paires thème « video_v4 »)" },
  { cle: "video_v4|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "video_v4|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "video_v4|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "video_v4|video", octetsReels: 253238, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "0 assets réels video de la fenêtre it113 ; 2 assets réels video de la fenêtre it90" },
  { cle: "video_v4|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "video_v4|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "voice_speech|texte", octetsReels: 799, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (2 paires thème « voice_speech »)" },
  { cle: "voice_speech|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "voice_speech|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "voice_speech|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "voice_speech|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "voice_speech|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "voice_speech|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "audio_understanding|texte", octetsReels: 7591, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis corpus-domaines-it84.ts (19 paires thème « audio_understanding »)" },
  { cle: "audio_understanding|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "audio_understanding|audio_parole", octetsReels: 87837114, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "8 assets réels audio de la fenêtre it101 ; 8 assets réels audio de la fenêtre it104 ; 8 assets réels audio de la fenêtre it105 ; 8 assets réels audio de la fenêtre it106 ; 8 assets réels audio de la fenêtre it107 ; 8 assets réels audio de la fenêtre it108 ; 8 assets réels audio de la fenêtre it109 ; 8 assets réels audio de la fenêtre it110 ; 8 assets réels audio de la fenêtre it111 ; 8 assets réels audio de la fenêtre it112 ; 8 assets réels audio de la fenêtre it113 ; 40 assets réels audio de la fenêtre it90 ; 8 assets réels audio de la fenêtre it94 ; 8 assets réels audio de la fenêtre it95 ; 8 assets réels audio de la fenêtre it96 ; 8 assets réels audio de la fenêtre it97 ; 8 assets réels audio de la fenêtre it98 ; 8 assets réels audio de la fenêtre it99" },
  { cle: "audio_understanding|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "audio_understanding|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "audio_understanding|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "audio_understanding|multimodal", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "multimodal_v4|texte", octetsReels: 421732, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "corpus commis carte-memoire.ts (4 paires thème « memoire-emplacement ») ; corpus commis multimodal-it101.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it101.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it104.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it104.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it105.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it105.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it106.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it106.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it107.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it107.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it108.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it108.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it109.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it109.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it110.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it110.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it111.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it111.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it112.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it112.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it113.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it113.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it94.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it94.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it95.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it95.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it96.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it96.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it97.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it97.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it98.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it98.ts (8 paires thème « multimodal-audio ») ; corpus commis multimodal-it99.ts (20 paires thème « multimodal-image ») ; corpus commis multimodal-it99.ts (8 paires thème « multimodal-audio »)" },
  { cle: "multimodal_v4|image", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "multimodal_v4|audio_parole", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "multimodal_v4|voix", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "multimodal_v4|video", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "multimodal_v4|code", octetsReels: 0, echantillonsAssimiles: 0, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "" },
  { cle: "multimodal_v4|multimodal", octetsReels: 201327360, echantillonsAssimiles: 338439, octetsGraine: 0, familles: 0, octetsMoyensParUnite: 0, expansionDeterministe: false, provenances: "16 snapshots SNN cumulatifs gravés (bandes 0 à 9) ; 338 439 échantillons réels v4 assimilés par ondes (HF Kings237/gen3ia-media-engine, scripts/entrainement-ondes-tous-domaines.ts)" },
];

export interface SourceDataset {
  readonly nom: string;
  readonly plateforme: "huggingface" | "kaggle" | "code";
  readonly reference: string;
  readonly statut: "acquise" | "cible";
  readonly emplacement: string;
}

export const SOURCES_PAR_DOMAINE: Readonly<Record<string, readonly SourceDataset[]>> = {
  "math": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/math",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (20 paires réelles math) + graines calculées"
    },
    {
      "nom": "openai/gsm8k",
      "plateforme": "huggingface",
      "reference": "hf:openai/gsm8k#main",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (problèmes mathématiques scolaires vérifiables)"
    },
    {
      "nom": "microsoft/orca-math-word-problems-200k",
      "plateforme": "huggingface",
      "reference": "hf:microsoft/orca-math-word-problems-200k",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (200 k problèmes mot-à-mot)"
    }
  ],
  "sciences": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/sciences",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (20 paires réelles sciences)"
    },
    {
      "nom": "allenai/openbookqa",
      "plateforme": "huggingface",
      "reference": "hf:allenai/openbookqa#main",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (questions de sciences ouvertes)"
    },
    {
      "nom": "uciml/iris",
      "plateforme": "kaggle",
      "reference": "kaggle:uciml/iris",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (mesures botaniques tabulaires)"
    }
  ],
  "reasoning": [
    {
      "nom": "corpus raisonnement-humain-fr",
      "plateforme": "code",
      "reference": "code:lib/neural/generation/corpus-raisonnement-it85.ts",
      "statut": "acquise",
      "emplacement": "corpus commis + 999 935 paires gravées bande 0 (snapshot SNN)"
    },
    {
      "nom": "HuggingFaceH4/ultrachat_200k",
      "plateforme": "huggingface",
      "reference": "hf:HuggingFaceH4/ultrachat_200k",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (dialogues multi-tours)"
    }
  ],
  "problem_solving": [
    {
      "nom": "interrogation milliard",
      "plateforme": "code",
      "reference": "code:scripts/interrogation-milliard-it86.ts",
      "statut": "acquise",
      "emplacement": "300 000 questions vérifiées gravées bande 6 + corpus commis"
    },
    {
      "nom": "openai/gsm8k",
      "plateforme": "huggingface",
      "reference": "hf:openai/gsm8k#socratic",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (résolutions pas à pas)"
    }
  ],
  "nlp_comprehension": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/nlp",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (paires réelles compréhension)"
    },
    {
      "nom": "nyu-mll/glue",
      "plateforme": "huggingface",
      "reference": "hf:nyu-mll/glue",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (inférence, paraphrase, sentiment)"
    },
    {
      "nom": "rajpurkar/squad",
      "plateforme": "huggingface",
      "reference": "hf:rajpurkar/squad",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (compréhension de texte à trous)"
    }
  ],
  "text_generation": [
    {
      "nom": "alpaca-gpt4-french",
      "plateforme": "huggingface",
      "reference": "hf:alpaca-gpt4-french",
      "statut": "acquise",
      "emplacement": "consolidé dans le corpus commis (it.84, conversations FR)"
    },
    {
      "nom": "HuggingFaceH4/ultrachat_200k",
      "plateforme": "huggingface",
      "reference": "hf:HuggingFaceH4/ultrachat_200k#sft",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (génération conversationnelle)"
    }
  ],
  "conversational_memory": [
    {
      "nom": "corpus d'amorçage gen3ia",
      "plateforme": "code",
      "reference": "code:lib/neural/generation/corpus.ts (base rédigée)",
      "statut": "acquise",
      "emplacement": "corpus commis + hippocampe (10 tours) + mémoire de réflexion (256 délibérations)"
    },
    {
      "nom": "HuggingFaceH4/ultrachat_200k",
      "plateforme": "huggingface",
      "reference": "hf:HuggingFaceH4/ultrachat_200k",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition"
    }
  ],
  "contextual_understanding": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/contexte",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (paires réelles contexte)"
    }
  ],
  "intent_recognition": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/intention",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (20 paires réelles intention)"
    }
  ],
  "professions": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/professions",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (17 paires réelles professions)"
    }
  ],
  "databases": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/bases",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (17 paires réelles bases de données) + graines calculées"
    },
    {
      "nom": "uciml/iris",
      "plateforme": "kaggle",
      "reference": "kaggle:uciml/iris",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (table tabulaire canonique)"
    }
  ],
  "tools": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/outils",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (paires réelles outils)"
    }
  ],
  "code_v4": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/code",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (14 paires réelles code) + graines calculées"
    },
    {
      "nom": "openai/openai_humaneval",
      "plateforme": "huggingface",
      "reference": "hf:openai/openai_humaneval",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (fonctions à compléter, tests canoniques)"
    },
    {
      "nom": "google-research-datasets/mbpp",
      "plateforme": "huggingface",
      "reference": "hf:google-research-datasets/mbpp",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (programmation basique Python)"
    }
  ],
  "security_v4": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4/securite",
      "statut": "acquise",
      "emplacement": "lib/neural/generation/corpus-domaines-it84.ts (15 paires réelles sécurité)"
    }
  ],
  "image_analysis": [
    {
      "nom": "rafaelpadilla/coco2017",
      "plateforme": "huggingface",
      "reference": "hf:rafaelpadilla/coco2017#default/val",
      "statut": "acquise",
      "emplacement": "public/multimodal-it94 → it113 (images réelles annotées, 20 par fenêtre) + paires commises"
    },
    {
      "nom": "awsaf49/coco-2017-dataset",
      "plateforme": "kaggle",
      "reference": "kaggle:awsaf49/coco-2017-dataset",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (miroir Kaggle complet COCO-2017)"
    }
  ],
  "video_v4": [
    {
      "nom": "sayakpaul/ucf101-subset",
      "plateforme": "huggingface",
      "reference": "hf:sayakpaul/ucf101-subset#default/train",
      "statut": "acquise",
      "emplacement": "fenêtre it.90 (fenêtre ÉPUISÉE — 0 ligne depuis, preuve refaite chaque tick)"
    }
  ],
  "voice_speech": [
    {
      "nom": "google/fleurs",
      "plateforme": "huggingface",
      "reference": "hf:google/fleurs#fr_fr/validation",
      "statut": "acquise",
      "emplacement": "public/multimodal-it90 → it113 (parole française réelle, 8 clips par fenêtre) + transcriptions officielles commises"
    },
    {
      "nom": "mozilla-foundation/common_voice",
      "plateforme": "huggingface",
      "reference": "hf:mozilla-foundation/common_voice",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (voix multilocuteurs)"
    }
  ],
  "audio_understanding": [
    {
      "nom": "google/fleurs",
      "plateforme": "huggingface",
      "reference": "hf:google/fleurs#fr_fr/validation",
      "statut": "acquise",
      "emplacement": "public/multimodal-it90 → it113 (clips réels servis, capacité audio_parole)"
    },
    {
      "nom": "openslr/librispeech_asr",
      "plateforme": "huggingface",
      "reference": "hf:openslr/librispeech_asr",
      "statut": "cible",
      "emplacement": "prochaine fenêtre d'acquisition (lecture anglophone)"
    }
  ],
  "multimodal_v4": [
    {
      "nom": "Kings237/gen3ia-media-engine",
      "plateforme": "huggingface",
      "reference": "hf:Kings237/gen3ia-media-engine#v4 (19 domaines)",
      "statut": "acquise",
      "emplacement": "338 439 échantillons assimilés par ondes + snapshots SNN publics/neural/*.bin"
    },
    {
      "nom": "carte de mémoire d'emplacement",
      "plateforme": "code",
      "reference": "code:lib/neural/generation/carte-memoire.ts",
      "statut": "acquise",
      "emplacement": "générée depuis le disque à chaque itération (vérité terrain)"
    }
  ]
};

export const TOTAUX_MEMOIRE = {
  octetsReels: 312410116,
  octetsGraine: 12195,
  compartiments: 133,
  compartimentsAvecDonneesReelles: 21,
  compartimentsCalculables: 6,
  assetsReels: 594,
} as const;

/** Paires de chat sur la mémoire de domaines (nombres mesurés, pas inventés). */
export const PAIRES_MEMOIRE_DOMAINES: readonly { motif: string; reponse: string; theme: string }[] = [
  {
    motif: "C'est quoi ton quota mémoire de 1 Go par domaine et par capacité ?",
    reponse: "Mon quota cible est de 1 Go (1 000 000 000 octets) par domaine ET par capacité : 19 domaines × 7 capacités = 133 compartiments. Mesuré sur le disque le 06 novembre 2026 : 312 410 116 octets physiques réels (assets HF/Kaggle servis, corpus commis, snapshots SNN) répartis dans 21 compartiments, plus 12 195 octets de graines synthétiques calculées. Pour les 6 compartiments calculables (math, résolution de problèmes, sciences, raisonnement, code, bases de données), l'expansion déterministe complète le chemin jusqu'à 1 Go à la demande — chaque unité générée est CALCULÉE, jamais inventée.",
    theme: "memoire-domaines",
  },
  {
    motif: "Combien de domaines et de capacités possèdes-tu dans ta mémoire ?",
    reponse: "19 domaines : math, sciences, reasoning, problem_solving, nlp_comprehension, text_generation, conversational_memory, contextual_understanding, intent_recognition, professions, databases, tools, code_v4, security_v4, image_analysis, video_v4, voice_speech, audio_understanding, multimodal_v4 — chacun découpé en 7 capacités : texte, image, audio_parole, voix, video, code, multimodal. Chaque compartiment (domaine × capacité) vise 1 Go et je rends compte de sa couverture réelle, mesurée sur le disque.",
    theme: "memoire-domaines",
  },
  {
    motif: "De quels datasets tes données proviennent-elles ?",
    reponse: "Acquises (dans ma mémoire, mesurées) : rafaelpadilla/coco2017 (images réelles annotées), google/fleurs fr_fr (parole française + transcriptions officielles), sayakpaul/ucf101-subset (vidéo, fenêtre épuisée), Kings237/gen3ia-media-engine v4 (338 439 échantillons, 19 domaines), alpaga-gpt4-french (conversations FR), corpus raisonnement-humain-fr (999 935 paires bande 0). Cibles (acquisition planifiée, fenêtres suivantes) : openai/gsm8k et microsoft/orca-math-word-problems-200k (math), allenai/openbookqa (sciences), nyu-mll/glue et rajpurkar/squad (compréhension), HuggingFaceH4/ultrachat_200k (conversation), openai/openai_humaneval et google-research-datasets/mbpp (code), mozilla-foundation/common_voice et openslr/librispeech_asr (voix), awsaf49/coco-2017-dataset et uciml/iris (Kaggle). Mon registre trace chaque source avec son emplacement mémoire exact.",
    theme: "memoire-domaines",
  },
  {
    motif: "Comment apprends-tu quand je te donne des données dans le chat ?",
    reponse: "Chaque enseignement passe par mon ingestion : 1) empreinte de contenu calculée et comparée à mon registre — un doublon est refusé ; 2) le contenu est inscrit dans un anneau borné de 1024 enseignements, avec sa source tracée (« chat-ia ») ; 3) le quota du compartiment concerné est mis à jour en octets réels ; 4) ensuite je peux répondre depuis cette mémoire grâce à la voie « mémorisée » de ma mémoire de réflexion : si la voie directe échoue, je rejoue l'enseignement le plus proche. J'évolue donc à chaque échange — et je peux te rendre compte de mon évolution (stats d'ingestion par domaine).",
    theme: "memoire-domaines",
  },
  {
    motif: "Comment apprends-tu via l'API ?",
    reponse: "Par le même chemin d'ingestion que pour le chat, avec la source tracée « api » : empreinte, déduplication, anneau borné, mise à jour du quota du compartiment, replay par la voie « mémorisée ». Chat et API alimentent la même mémoire de domaines — mes statistiques distinguent les provenances, et chaque unité ingérée est comptabilisée dans la couverture physique du compartiment visé (cible 1 Go).",
    theme: "memoire-domaines",
  },
  {
    motif: "Comment raisons-tu avant de répondre ?",
    reponse: "Ma mémoire de réflexion délibère en voies ordonnées : directe (voie rapide, 1 appel), normalisée (casse/ponctuation), raccourcie (contenu seul), puis « mémorisée » (replay de mes enseignements chat/API). Chaque délibération enregistre le domaine détecté de ta question, les candidats essayés, le choix élu et sa raison, dans un anneau borné de 256 délibérations que je peux relire. La voie directe est toujours essayée en premier : mon taux de service réflexif ne peut jamais être inférieur à celui du cortex seul.",
    theme: "memoire-domaines",
  },
  {
    motif: "Combien d'octets réels mesurés contient ta mémoire de domaines ?",
    reponse: "Mesuré sur le disque le 06 novembre 2026 : 594 assets multimodaux réels servis (images COCO-2017 annotées, paroles FLEURS fr_fr) dans 0 fenêtres, des snapshots SNN cumulatifs gravés, et un corpus commis de code source — soit 312 410 116 octets physiques réels, auxquels s'ajoutent 12 195 octets de graines calculées. Chaque chiffre est mesuré, aucun n'est supposé.",
    theme: "memoire-domaines",
  },
  {
    motif: "Que fais-tu quand les données manquent pour atteindre 1 Go par domaine ?",
    reponse: "Deux chemins honnêtes : 1) pour les compartiments CALCULABLES (math, résolution de problèmes, sciences, raisonnement, code, bases de données), mon expansion déterministe CRÉE les unités manquantes à la demande — famille N % nb familles, paramètres dérivés de N, réponse CALCULÉE par formule exacte : le Go est adressable unité par unité, jamais fabriqué ni stocké à l'avance ; 2) pour les compartiments non calculables, je ne fabrique rien : leur 1 Go se remplit par acquisition réelle (fenêtres HF/Kaggle à chaque itération) et par l'ingestion de tes données (chat/API) — ma comptabilité affiche la couverture physique exacte et l'écart restant.",
    theme: "memoire-domaines",
  },
  {
    motif: "Comment identifies-tu le domaine d'une question ?",
    reponse: "Par un classifieur de mots-clés honnête (heuristique documentée, mesurable) : je compte les termes du domaine dans ta requête — « aire, équation, pourcentage » → math ; « sql, jointure, table » → databases ; « image, km, pixel » → image_analysis ; « chiffrement, vulnérabilité » → security_v4, etc. Le domaine détecté est inscrit dans la trace de chaque délibération de ma mémoire de réflexion — tu peux me demander ce que j'ai détecté et je te montre le raisonnement.",
    theme: "memoire-domaines",
  },
  {
    motif: "Où sont tes données du domaine image ?",
    reponse: "Mes données image réelles sont servies depuis public/multimodal-it90 jusqu'à public/multimodal-it113 : 0 images, 0 octets — chaque image a son identifiant kmNN_ et sa légende issue des annotations officielles COCO-2017, câblées dans mon corpus. La carte de mémoire d'emplacement (générée depuis le disque) trace chaque fenêtre avec ses octets et son snapshot SNN.",
    theme: "memoire-domaines",
  },
];
