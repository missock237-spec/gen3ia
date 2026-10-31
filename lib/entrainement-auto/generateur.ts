import "server-only";

import { IDS_VOCATION } from "@/lib/gen3/vocation";
import { paireGenere } from "@/lib/gen3/generateur-datasets";
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
