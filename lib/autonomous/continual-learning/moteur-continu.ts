/**
 * CONTINUAL LEARNING ENGINE (Lot 7 du plan « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Permet au cerveau d'évoluer SANS réentraînement complet systématique
 * (Règle 13 de la mission), avec une GARDE ANTI-OUBLI CATASTROPHIQUE
 * (Règle 14) : toute modification neuronale passe par
 *
 *   1. évaluation PRÉ sur des sondes (sondes mémoire + sondes d'oubli) ;
 *   2. SAUVEGARDE de la version précédente (token d'état restaurable) ;
 *   3. adaptation CIBLÉE et BORNÉE (mécanisme C — pas de réentraînement) ;
 *   4. évaluation POST sur LES MÊMES sondes ;
 *   5. comparaison : dégradation détectée → RESTAURATION immédiate + rapport
 *      honnête ; sinon commit + gain mesuré.
 *
 * Mécanismes du plan :
 *   A. Knowledge Learning  — l'intégration mémoire est déjà le fait du
 *      pipeline (Lots 4-5) ; ce moteur fournit les sondes dérivées.
 *   B. Cognitive Learning  — fusion des RELATIONS nouvelles dans les
 *      connaissances existantes (relations enrichies, provenance tracée).
 *   C. Neural Adaptation   — l'adaptation bornée via le sous-moteur injecté
 *      (production : petites sessions du système par ondes existant —
 *      entrainement-ondes.ts, JAMAIS un réentraînement complet).
 */

import type { MemoireConnaissances } from "../knowledge/memoire-connaissances";

/** Une sonde : question + réponse attendue (mesurable, dérivée de la mémoire). */
export interface Sonde {
  question: string;
  attendu: string;
}

/** Sous-moteur neuronal injectable (production : entrainement-ondes borné). */
export interface SousMoteurNeural {
  /** Évalue des sondes → score réel 0..1 (jaccard sur tokens). */
  evaluer(sondes: Sonde[]): Promise<number>;
  /** Adaptation CIBLÉE et BORNÉE (petit lot, jamais un réentraînement). */
  adapter(echantillons: Array<{ question: string; reponse: string }>): Promise<{ ok: boolean; message: string }>;
  /** Sauvegarde l'état actuel → token restaurable. */
  sauvegarder(): Promise<string>;
  /** Restaure un état sauvegardé (rollback anti-oubli). */
  restaurer(token: string): Promise<boolean>;
}

/** Résultat honnête d'une adaptation gardée. */
export interface ResultatAdaptation {
  statut: "applique" | "annule" | "echec";
  scorePre: number;
  scorePost: number;
  /** Δ mesuré (post − pré). */
  delta: number;
  message: string;
  rollbackEffectue: boolean;
}

/** Seuil de dégradation tolérée (au-delà : rollback). */
export const SEUIL_DEGRADATION = 0.02;

/** Mécanisme B — enrichit les relations des connaissances existantes. */
export function fusionnerRelations(memoire: MemoireConnaissances, nouvelles: Array<{ idConcept: string; relations: Array<{ relation: string; cible: string }>; provenanceId: string }>): number {
  let ajoutees = 0;
  for (const n of nouvelles) {
    const conn = memoire.obtenir(n.idConcept);
    if (!conn) continue;
    let modifiee = false;
    for (const r of n.relations) {
      if (!conn.relations.some((e) => e.relation === r.relation && e.cibleConcept === r.cible)) {
        conn.relations.push({
          relation: r.relation,
          cibleConcept: r.cible,
          provenanceId: n.provenanceId,
          dateIso: new Date().toISOString(),
        });
        ajoutees += 1;
        modifiee = true;
      }
    }
    if (modifiee) memoire.persisterConnaissance(n.idConcept);
  }
  return ajoutees;
}

/** Sondes dérivées de la mémoire (mécanisme A) : questions→résumés vérifiés. */
export function sondesDepuisMemoire(memoire: MemoireConnaissances, plafond = 20): Sonde[] {
  const sondes: Sonde[] = [];
  for (const domaine of ["developpement_web", "test", "analyse_donnees", "sciences_professionnel"]) {
    for (const c of memoire.parDomaine(domaine, 5)) {
      const mots = c.concept.split(/\s+/).slice(0, 4).join(" ");
      sondes.push({ question: `Que sais-tu de « ${mots} » ?`, attendu: c.resume.slice(0, 120) });
      if (sondes.length >= plafond) return sondes;
    }
  }
  return sondes;
}

/**
 * MÉCANISME C — adaptation neuronale GARDÉE : pré-évaluation → sauvegarde →
 * adaptation bornée → post-évaluation → rollback si oubli catastrophique.
 * Ne jamais déclarer une adaptation réussie sans mesure pré/post réelle.
 */
export async function adapterSansOubli(
  sousMoteur: SousMoteurNeural,
  echantillons: Array<{ question: string; reponse: string }>,
  sondesStabilite: Sonde[],
): Promise<ResultatAdaptation> {
  // 1. Évaluation PRÉ (sondes de stabilité = mémoire + sonde d'oubli).
  const scorePre = await sousMoteur.evaluer(sondesStabilite);
  if (!Number.isFinite(scorePre)) {
    return { statut: "echec", scorePre: NaN, scorePost: NaN, delta: NaN, message: "score pré invalide — adaptation refusée", rollbackEffectue: false };
  }

  // 2. Sauvegarde de l'état précédent (token restaurable).
  const token = await sousMoteur.sauvegarder();

  // 3. Adaptation CIBLÉE et BORNÉE.
  const r = await sousMoteur.adapter(echantillons);
  if (!r.ok) {
    const restaure = await sousMoteur.restaurer(token);
    return { statut: "echec", scorePre, scorePost: scorePre, delta: 0, message: `adaptation échouée : ${r.message}${restaure ? " — état restauré" : " — restauration impossible (documenté)"}`, rollbackEffectue: restaure };
  }

  // 4. Évaluation POST sur LES MÊMES sondes.
  const scorePost = await sousMoteur.evaluer(sondesStabilite);
  const delta = Math.round((scorePost - scorePre) * 1000) / 1000;

  // 5. Garde anti-oubli : dégradation → restauration immédiate.
  if (scorePost < scorePre - SEUIL_DEGRADATION) {
    const restaure = await sousMoteur.restaurer(token);
    return {
      statut: "annule",
      scorePre,
      scorePost,
      delta,
      message: `oubli catastrophique détecté (Δ ${delta} < −${SEUIL_DEGRADATION}) — adaptation ANNULÉE${restaure ? ", état précédent restauré" : ", restauration IMPOSSIBLE (documenté)"}`,
      rollbackEffectue: restaure,
    };
  }
  return { statut: "applique", scorePre, scorePost, delta, message: `adaptation appliquée (Δ ${delta} mesuré sur ${sondesStabilite.length} sondes)`, rollbackEffectue: false };
}

/**
 * Moteur continu complet : A (sondes mémoire) + B (fusion relations) +
 * C (adaptation gardée). Une fonction par lot du pipeline continu.
 */
export async function lotApprentissageContinu(
  options: {
    memoire: MemoireConnaissances;
    sousMoteur: SousMoteurNeural;
    echantillonsNeuronaux: Array<{ question: string; reponse: string }>;
    relationsNouvelles?: Array<{ idConcept: string; relations: Array<{ relation: string; cible: string }>; provenanceId: string }>;
  },
): Promise<{ relationsFusionnees: number; adaptation: ResultatAdaptation | null; sondes: number }> {
  // B. Cognitive Learning — relations enrichies (traçées).
  const relationsFusionnees = options.relationsNouvelles
    ? fusionnerRelations(options.memoire, options.relationsNouvelles)
    : 0;

  // A. Knowledge Learning — sondes dérivées de la mémoire vérifiée.
  const sondes = sondesDepuisMemoire(options.memoire);

  // C. Neural Adaptation — bornée et gardée (anti-oubli).
  const adaptation =
    options.echantillonsNeuronaux.length > 0 && sondes.length > 0
      ? await adapterSansOubli(options.sousMoteur, options.echantillonsNeuronaux.slice(0, 40), sondes)
      : null;

  return { relationsFusionnees, adaptation, sondes: sondes.length };
}
