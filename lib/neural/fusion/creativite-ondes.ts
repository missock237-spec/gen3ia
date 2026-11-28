/**
 * CRÉATIVITÉ GÉNÉRATIVE SUR ONDES — mission « plus créatif que les géants ».
 *
 * La créativité n'est pas une recombinaison aveugle : Gen3 génère des
 * CANDIDATS (paires/triplets de concepts issus des graines de l'utilisateur
 * ET de sa mémoire d'ondes — ses échanges vécus), puis les note par un
 * DOUBLE CRITÈRE mesuré dans le champ :
 *  · NOUVEAUTÉ : le candidat ne doit pas exister dans la mémoire commise
 *    (ressemblance faible aux traces = idée jamais vécue) ;
 *  · COHÉRENCE : l'injection des ondes du candidat dans le champ produit
 *    une résonance ordonnée (ordre de Kuramoto r élevé = la combinaison
 *    « tient ensemble » physiquement).
 * Score final = cohérence × (1 + bonus nouveauté) — les idées rangées par
 * le champ lui-même, déterministe.
 */

import { extraireConcepts, NoeudOndesUnifie, MAX_TRACES } from "./noeud-ondes-unifie";
import { projeterConcept } from "./encodeur-multimodal-unifie";

export interface IdeeCandidat {
  /** La combinaison de concepts générée. */
  combinaison: string;
  /** Cohérence physique mesurée dans le champ (∈ [0, 1] — ordre de Kuramoto). */
  coherence: number;
  /** Nouveauté : 1 − ressemblance maximale aux souvenirs commis (∈ [0, 1]). */
  nouveaute: number;
  /** Score final rangé (cohérence × (1 + nouveauté)). */
  score: number;
}

/** Voisins conceptuels : concepts récents du champ (mémoire vécue). */
function conceptsVecins(noeud: NoeudOndesUnifie, plafond = 24): string[] {
  const traces = noeud.dernieresTraces(plafond);
  const tous = traces.flatMap((t) => t.concepts);
  return [...new Set(tous)];
}

/** Recombinaisons déterministes : paires puis triplets de concepts distincts. */
function candidats(graines: string[], vecins: string[], plafond = 40): string[][] {
  const pool = [...new Set([...graines, ...vecins])];
  const sorties: string[][] = [];
  for (let i = 0; i < pool.length && sorties.length < plafond; i++) {
    for (let j = i + 1; j < pool.length && sorties.length < plafond; j++) {
      sorties.push([pool[i], pool[j]]);
      if (sorties.length < plafond && j + 1 < pool.length) {
        sorties.push([pool[i], pool[j], pool[j + 1]]);
      }
    }
  }
  return sorties;
}

/** Ressemblance d'un candidat aux souvenirs : concepts communs en proportion. */
function ressemblanceMax(conceptsCandidat: string[], noeud: NoeudOndesUnifie): number {
  const traces = noeud.dernieresTraces(MAX_TRACES);
  let max = 0;
  for (const trace of traces) {
    const communs = conceptsCandidat.filter((c) => trace.concepts.includes(c)).length;
    const proportion = communs / Math.max(1, conceptsCandidat.length);
    // Existe verbatim dans un souvenir → ressemblance totale.
    const verbatim = trace.texte.toLowerCase().includes(conceptsCandidat.join(" ")) ? 1 : proportion;
    max = Math.max(max, verbatim);
  }
  return max;
}

/** Cohérence physique : injecte les ondes du candidat, lit l'ordre r du champ. */
async function coherenceChamp(noeud: NoeudOndesUnifie, conceptsCandidat: string[]): Promise<number> {
  const impulsions = conceptsCandidat.flatMap((c) => noeud.impulsionsConcept(c));
  const comprehension = await noeud.comprendreImpulsions(impulsions);
  // r ∈ [0, 1] — normalisé par l'énergie pour ne pas confondre bruit et ordre.
  const normalise = comprehension.ordreR;
  return Math.min(1, normalise * 2); // amplification douce (r brut est faible sur grille petite)
}

/**
 * Génère les idées créatives : recombinaisons des graines + mémoire vécue,
 * rangées par cohérence × nouveauté — mesurées dans le champ réel.
 */
export async function genererIdeesCreatives(noeud: NoeudOndesUnifie, graines: string, nombre = 5): Promise<IdeeCandidat[]> {
  const grainesConcepts = extraireConcepts(graines);
  const vecins = conceptsVecins(noeud);
  const combinaisons = candidats(grainesConcepts, vecins);
  const resultats: IdeeCandidat[] = [];
  for (const combinaison of combinaisons) {
    if (combinaison.length < 2) continue;
    const coherence = await coherenceChamp(noeud, combinaison);
    const nouveaute = 1 - ressemblanceMax(combinaison, noeud);
    const score = coherence * (1 + nouveaute);
    resultats.push({
      combinaison: combinaison.join(" "),
      coherence: Math.round(coherence * 1000) / 1000,
      nouveaute: Math.round(nouveaute * 1000) / 1000,
      score: Math.round(score * 1000) / 1000,
    });
  }
  return resultats.sort((a, b) => b.score - a.score).slice(0, nombre);
}

/** Sanity : la projection d'un concept est déterministe (pour les tests). */
export function signatureDeterministe(concept: string, largeur = 64, hauteur = 48): { x: number; y: number; frequence: number } {
  const impulsion = projeterConcept(concept, largeur, hauteur).impulsions[0];
  return impulsion ? { x: impulsion.x, y: impulsion.y, frequence: impulsion.frequence } : { x: -1, y: -1, frequence: -1 };
}
