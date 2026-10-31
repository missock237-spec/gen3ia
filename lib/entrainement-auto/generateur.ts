import "server-only";

import { IDS_VOCATION } from "@/lib/gen3/vocation";
import { paireGenere } from "@/lib/gen3/generateur-datasets";
import { espaceQuestionsDomaine, paireQuestionGenere } from "@/lib/gen3/corpus-questions";
import type { PaireLangage } from "@/lib/neural/generation/corpus";

/**
 * SOURCE INTERNE — LE GÉNÉRATEUR DE DATASETS DANS LA BOUCLE
 * D'AUTO-APPRENTISSAGE (it.65).
 *
 * Demande propriétaire : « un système qui va permettre à gen3 d'apprendre
 * du générateur de dataset, pour qu'il puisse TOUJOURS CONTINUER à
 * s'améliorer en continu ». Cette source garantit que le cycle n'est plus
 * jamais à court de matière : quand les hubs externes ne fournissent rien
 * (non configurés, rien de nouveau, erreurs réseau), la fabrique interne
 * (lib/gen3/generateur-datasets) produit un lot de paires de vocation
 * TOUJOURS NOUVEAU (offset bijection = cycle × taille — anti-rejoue).
 * Zéro accès réseau, indéfiniment reproductible, honnêteté intégrale :
 * la matière est synthétique et le rapport le dit.
 */

/** Taille du lot générateur par cycle (plafonnée — honnête, incrémentale). */
export const PAIRES_GENERATEUR_PAR_CYCLE = 240;

/** Empreinte de source interne dans les rapports de cycle. */
export const REF_GENERATEUR = "generateur-interne-vocation";

/**
 * Un lot de paires conversationnelles générées depuis la charte de
 * vocation — DÉTERMINISTE et TOUJOURS NOUVEAU pour un cycle donné
 * (l'offset avance dans la bijection : aucun texte déjà vu n'est régénéré).
 */
export function apportGenerateur(cycleIndex: number): PaireLangage[] {
  const parDomaine = Math.floor(PAIRES_GENERATEUR_PAR_CYCLE / IDS_VOCATION.length);
  const offset = Math.max(0, Math.floor(cycleIndex)) * PAIRES_GENERATEUR_PAR_CYCLE;
  const paires: PaireLangage[] = [];
  for (let k = 0; k < IDS_VOCATION.length; k++) {
    const id = IDS_VOCATION[k] ?? "";
    for (let j = 0; j < parDomaine; j++) {
      const i = offset + k * parDomaine + j;
      const { motif, reponse, theme } = paireGenere(id, i);
      paires.push({ motif, reponse, theme });
    }
  }
  return paires;
}

/* ------------------------------------------------------------------ */
/* IT.67 — SOURCE INTERNE QUESTIONS : le cycle génère AUSSI des         */
/* QUESTIONS du cadre d'apprentissage (demande propriétaire : « fais    */
/* en sorte qu'il soit capable de répondre à des questions qui rentrent */
/* dans son cadre d'apprentissage ») — paires question→réponse ancrées  */
/* charte, TOUJOURS NOUVELLES dans la session (offset anti-rejoue =     */
/* cycle × taille), formant le SNN à la FORME question→réponse.         */
/* ------------------------------------------------------------------ */

/** Taille du lot QUESTIONS par cycle (6/domaine × 19 — incrémental). */
export const QUESTIONS_VOCATION_PAR_CYCLE = 114;

/** Empreinte de la source questions dans les rapports de cycle. */
export const REF_QUESTIONS_VOCATION = "generateur-questions-vocation";

/** Espace TOTAL de questions uniques (fini, mesuré — somme des 19 domaines). */
export function espaceQuestionsTotal(): { fr: number; en: number; total: number } {
  let fr = 0;
  let en = 0;
  for (const id of IDS_VOCATION) {
    const espace = espaceQuestionsDomaine(id);
    fr += espace.fr;
    en += espace.en;
  }
  return { fr, en, total: fr + en };
}

/**
 * Un lot de paires QUESTION→RÉPONSE générées depuis le corpus du cadre
 * (lib/gen3/corpus-questions) — DÉTERMINISTE et TOUJOURS NOUVEAU pour un
 * cycle donné (l'offset avance dans l'espace mesuré par domaine ; au-delà
 * de l'espace, le modulo rejoue — consolidation de la forme, rapportée).
 */
export function apportQuestionsVocation(cycleIndex: number): PaireLangage[] {
  const parDomaine = Math.floor(QUESTIONS_VOCATION_PAR_CYCLE / IDS_VOCATION.length);
  const offset = Math.max(0, Math.floor(cycleIndex)) * QUESTIONS_VOCATION_PAR_CYCLE;
  const paires: PaireLangage[] = [];
  for (let k = 0; k < IDS_VOCATION.length; k++) {
    const id = IDS_VOCATION[k] ?? "";
    for (let j = 0; j < parDomaine; j++) {
      const i = offset + k * parDomaine + j;
      const { question, reponse, theme } = paireQuestionGenere(id, i);
      paires.push({ motif: question, reponse, theme });
    }
  }
  return paires;
}
