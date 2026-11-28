/**
 * RAISONNEMENT EN ONDES — CHAÎNE DE PENSÉE (méthode d'amélioration 4 de
 * l'analyse experte, fusionnée avec la recommandation du propriétaire).
 *
 * Le raisonnement multi-étapes n'est plus pré-calculé uniquement dans le
 * corpus : chaque ÉTAPE du raisonnement est résolue par les solveurs
 * exacts LOCAUX (zéro IA externe) puis COMMISE COMME ONDE dans le champ
 * du SNOU — mémoire et raisonnement sont le même système : l'étape 2
 * résonne avec le résultat de l'étape 1, la synthèse finale émerge de la
 * chaîne d'ondes commise, et la chaîne entière reste mémorisée (les
 * raisonnements passés enrichissent la compréhension future).
 *
 * Décomposition : « calcule 17 × 23 puis ajoute 9 » → étapes
 * [« 17 × 23 », « 391 + 9 »] — chaque étape porte le résultat de la
 * précédente (dépendance compositionnelle réelle), déterministe.
 */

import { resoudreCalcul } from "@/lib/neural/solveurs/moteur-calcul";

import { NoeudOndesUnifie, type ResonanceMemoire } from "./noeud-ondes-unifie";

export interface EtapeRaisonnement {
  index: number;
  /** Énoncé de l'étape (portant les résultats précédents). */
  enonce: string;
  /** Résultat exact de l'étape (solveur local), null si non computable. */
  resultat: string | null;
  /** Id du paquet d'ondes commis pour cette étape. */
  traceId: string | null;
}

export interface RapportRaisonnement {
  /** La question était-elle décomposable en étapes ? */
  decomposee: boolean;
  etapes: EtapeRaisonnement[];
  /** Réponse finale — émergente de la chaîne d'ondes (dernier paquet). */
  reponseFinale: string | null;
  /** La synthèse a-t-elle été vérifiée par résonance dans le champ ? */
  verifieeParResonance: boolean;
}

/** Segmentateurs d'étapes arithmétiques (déterministes). */
const SEGMENTEURS = [
  /\s*(?:puis|ensuite|après\s*quoi|then)\s*/i,
  /\s*(?:et\s+)(?:ajoute|additionne|soustrais|multiplie|divise)\s*/i,
];

/** Décompose une question arithmétique composée en étapes brutes. */
export function decomposerEtapes(question: string): string[] {
  let segments = [question.trim()];
  for (const segmenteur of SEGMENTEURS) {
    segments = segments.flatMap((segment) => segment.split(segmenteur));
  }
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Porte un énoncé avec le résultat précédent : « ajoute 9 » → « 391 + 9 ». */
function porterResultat(etape: string, resultatPrecedent: string | null): string {
  if (!resultatPrecedent) return etape;
  const porteur = etape.replace(
    /^(ajoute|additionne)\s+/i,
    `${resultatPrecedent} + `,
  ).replace(
    /^(soustrais|retire)\s+/i,
    `${resultatPrecedent} - `,
  ).replace(
    /^(multiplie|multiplie\s*par)\s+/i,
    `${resultatPrecedent} × `,
  );
  return porteur;
}

/**
 * RAISONNEMENT MULTI-ÉTAPES EN ONDES : chaque étape → solveur local exact
 * → commit d'onde → l'étape suivante porte le résultat ; vérification
 * finale par résonance de la question complète avec la chaîne commise.
 */
export async function raisonnerEnOndes(noeud: NoeudOndesUnifie, question: string): Promise<RapportRaisonnement> {
  const brutes = decomposerEtapes(question);
  if (brutes.length === 0) {
    return { decomposee: false, etapes: [], reponseFinale: null, verifieeParResonance: false };
  }

  const etapes: EtapeRaisonnement[] = [];
  let resultatPrecedent: string | null = null;
  for (let i = 0; i < brutes.length; i++) {
    const enonce = porterResultat(brutes[i], resultatPrecedent);
    const resultat = resoudreCalcul(enonce);
    let traceId: string | null = null;
    const concepts = [enonce, resultat ?? "etape-sans-resultat"];
    const commit = noeud.memoriser({
      modalite: "texte",
      concepts,
      texte: `étape ${i + 1}: ${enonce} = ${resultat ?? "?"}`,
    });
    if (commit.traceId) traceId = commit.traceId;
    etapes.push({ index: i, enonce, resultat, traceId });
    if (resultat) resultatPrecedent = resultat;
  }

  const dernier = etapes[etapes.length - 1];
  const reponseFinale = dernier?.resultat ?? null;

  // Vérification par résonance : la question complète doit résonner avec
  // la chaîne d'ondes commise (le raisonnement est DANS la mémoire).
  let verifieeParResonance = false;
  if (reponseFinale) {
    const comprehension = await noeud.comprendre(question);
    const idsEtapes = new Set(etapes.map((e) => e.traceId));
    verifieeParResonance = comprehension.resonances.some((r: ResonanceMemoire) => idsEtapes.has(r.traceId) && r.gain > 0);
  }

  return { decomposee: true, etapes, reponseFinale, verifieeParResonance };
}
