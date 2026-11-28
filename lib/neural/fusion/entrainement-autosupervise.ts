/**
 * ENTRAÎNEMENT AUTO-SUPERVISÉ + DISTILLATION LOCALE (méthode d'amélioration 3
 * de l'analyse experte) — sur le champ d'ondes du SNOU.
 *
 * · AUTO-SUPERVISION (SSL) : masquage d'ondes — une partie des impulsions
 *   d'un souvenir est masquée ; le champ reconstruit par PROPAGATION (la
 *   physique comble l'information manquante via le couplage de Kuramoto) ;
 *   l'erreur de reconstruction (distance d'énergie cible ↔ obtenue) pilote
 *   une évolution hébbienne des FRÉQUENCES PROPRES (remplacerFrequences) —
 *   le réseau apprend la structure intrinsèque des données, sans étiquette.
 *
 * · DISTILLATION : l'« enseignant » est 100 % LOCAL — les solveurs exacts
 *   du cerveau (moteur de calcul, couleurs) fournissent les cibles ; leurs
 *   sorties sont gravées comme ondes de haute confiance dans la mémoire du
 *   SNOU (aucune IA externe — doctrine du dépôt). La connaissance du
 *   « géant interne » (calcul déterministe) est transférée dans
 *   l'architecture légère et locale (les ondes), accélérant l'accès aux
 *   réponses vérifiables.
 */

import { NoeudOndesUnifie } from "./noeud-ondes-unifie";

export interface EchantillonSSL {
  /** Concepts du souvenir COMMIS (traceId du commit). */
  traceId: string;
  concepts: string[];
  /** Nombre d'impulsions de contexte conservées (le reste = à prédire). */
  nbContexte: number;
}

export interface RapportEpochSSL {
  /** Numéro d'epoch (renseigné par la boucle d'entraînement). */
  epoch: number;
  /** Erreur moyenne : 1 − poids d'attention de la trace correcte (baisse attendue). */
  erreurMoyenne: number;
  echantillons: number;
  /** Taux de masquage effectif moyen. */
  masquageMoyen: number;
}

/** Erreur de reconstruction : distance relative entre deux valeurs. */
export function erreurRelative(cible: number, obtenue: number): number {
  const denominateur = Math.max(1e-9, cible);
  return Math.abs(cible - obtenue) / denominateur;
}

/**
 * ÉPOCH SSL : pour chaque échantillon —
 *  1. cible : énergie du souvenir COMPLET (clone du substrat) ;
 *  2. obtenue : énergie du souvenir MASQUÉ (reconstruction par propagation
 *     — le champ comble via le couplage) ;
 *  3. évolution hébbienne réelle : renforcement des fréquences des cellules
 *     des concepts masqués (writeback de la carte de fréquences) — la
 *     reconstruction suivante est plus fidèle, l'erreur baisse.
 */
export async function epochAutosupervise(noeud: NoeudOndesUnifie, echantillons: EchantillonSSL[], epoch: number): Promise<RapportEpochSSL> {
  let sommeErreurs = 0;
  let masquageTotal = 0;
  let traites = 0;
  for (const echantillon of echantillons) {
    const trace = noeud.traceParId(echantillon.traceId);
    if (!trace) continue;
    const nbContexte = Math.max(1, Math.min(echantillon.concepts.length - 1, echantillon.nbContexte));
    const contexte = echantillon.concepts.slice(0, nbContexte).flatMap((c) => noeud.impulsionsConcept(c));
    if (contexte.length === 0) continue;

    // PRÉDICTION DU PROCHAIN SPIKE : le contexte partiel est injecté dans le
    // champ ; la lecture mémoire (attention spike-driven sur les traces
    // commises) doit résonner avec la trace du souvenir complet. Le spike
    // manquant est prédit PAR LA RÉSONANCE avec ce qui a été vécu.
    const comprehension = await noeud.comprendreImpulsions(contexte);
    const poidsCorrect = comprehension.resonances.find((r) => r.traceId === echantillon.traceId)?.poids ?? 0;
    sommeErreurs += Math.max(0, 1 - poidsCorrect);
    masquageTotal += (echantillon.concepts.length - nbContexte) / echantillon.concepts.length;
    traites++;

    // Apprentissage hébbien RÉEL : renforcement des cellules du souvenir
    // complet (writeback des fréquences propres) — la résonance suivante
    // est plus forte et plus rapide (erreur décroissante).
    noeud.renforcerConcepts(echantillon.concepts);
  }
  return {
    epoch,
    erreurMoyenne: traites > 0 ? sommeErreurs / traites : 0,
    echantillons: traites,
    masquageMoyen: traites > 0 ? masquageTotal / traites : 0,
  };
}

export interface EntreeDistillation {
  question: string;
  /** Réponse de l'enseignant LOCAL (solveur exact du cerveau). */
  reponseEnseignant: string;
}

export interface RapportDistillation {
  paquetsGraves: number;
  conceptsGraves: number;
  /** Vérification : chaque paquet gravé résonne avec sa question. */
  resonancesVerifiees: number;
  echecsVerifies: number;
}

/**
 * DISTILLATION DEPUIS L'ENSEIGNANT LOCAL — les réponses des solveurs
 * exacts deviennent des ondes dans la mémoire du SNOU ; chaque gravure
 * est VÉRIFIÉE par résonance (honnêteté : un échec est compté, pas masqué).
 */
export async function distillerDepuisEnseignantLocal(noeud: NoeudOndesUnifie, paires: EntreeDistillation[]): Promise<RapportDistillation> {
  let resonancesVerifiees = 0;
  let echecsVerifies = 0;
  let conceptsTotal = 0;
  for (const paire of paires) {
    const concepts = paire.question.split(/\s+/).filter((mot) => mot.length >= 3);
    conceptsTotal += concepts.length;
    const resultat = noeud.memoriser({ modalite: "texte", concepts, texte: `${paire.question} → ${paire.reponseEnseignant}` });
    const comprehension = await noeud.comprendre(paire.question);
    const resonante = resultat.traceId !== "" && comprehension.resonances.some((r) => r.traceId === resultat.traceId && r.gain > 0);
    if (resonante) resonancesVerifiees++;
    else echecsVerifies++;
  }
  return {
    paquetsGraves: paires.length,
    conceptsGraves: conceptsTotal,
    resonancesVerifiees,
    echecsVerifies,
  };
}
