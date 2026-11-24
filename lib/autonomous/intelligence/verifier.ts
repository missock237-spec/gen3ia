/**
 * KNOWLEDGE VERIFICATION ENGINE (Lot 5 — vérification AVANT intégration,
 * Phase 5 du plan).
 *
 * Empêche les informations incorrectes d'intégrer la mémoire permanente :
 *  1. provenance — la source est-elle enregistrée et active ?
 *  2. crédibilité de la source — licence documentée, historique d'erreurs ;
 *  3. confirmation indépendante — d'autres sources distinctes disent-elles
 *     la même chose (connaissance existante en mémoire) ?
 *  4. contradictions — valeurs différentes pour la même propriété : les
 *     DEUX versions sont conservées et flaggées (jamais résolues de force) ;
 *  5. dates — contenu daté du futur = rejet ;
 *  6. niveau de confiance — mesuré, jamais inventé ;
 *  7. décision — APPROVED / QUARANTINED (incertain : en attente, PAS
 *     transformé en vérité) / REJECTED (indigeste ou non sourcé).
 */

import type { RegistreSources } from "../acquisition/source-registry";
import type { EnregistrementStructure } from "./traiter";
import type { MemoireConnaissances } from "../knowledge/memoire-connaissances";

/** Décision de vérification (traçable — conservée dans le lot). */
export interface DecisionVerification {
  statut: "APPROVED" | "QUARANTINED" | "REJECTED";
  /** Confiance mesurée 0..1 (jamais inventée). */
  confiance: number;
  /** Raisons honnêtes de la décision (historique du lot). */
  raisons: string[];
  /** Contradictions détectées (conservées, pas résolues). */
  contradictions: number;
}

/** Seuil de qualité minimum pour l'intégration (mesuré au Lot 4). */
const QUALITE_MIN = 0.3;

/**
 * VÉRIFIE un enregistrement structuré avant intégration mémoire.
 * Aucune information incertaine n'est transformée en vérité :
 *  - APPROVED : confiance ≥ 0.7 (source unique de haute qualité) OU
 *    confirmation indépendante (≥ 2 sources distinctes, mémoire + quarantaine) ;
 *  - QUARANTINED : incertain — conservé dans la zone de quarantaine avec sa
 *    structure, PROMU si une seconde source confirme (jamais transformé en
 *    vérité sans preuve) ;
 *  - REJECTED : indigeste ou non sourcé.
 */
export function verifierEnregistrement(
  enr: EnregistrementStructure,
  registre: RegistreSources,
  memoire: MemoireConnaissances,
  confirmationsQuarantaine = 0,
): DecisionVerification {
  const raisons: string[] = [];

  // 1. Provenance — source enregistrée et active (sinon : rien ne passe).
  const source = registre.obtenir(enr.provenance.sourceId);
  if (!source) {
    return { statut: "REJECTED", confiance: 0, raisons: [`source ${enr.provenance.sourceId} inconnue du registre — provenance non traçable`], contradictions: 0 };
  }
  if (source.statut !== "actif") {
    return { statut: "REJECTED", confiance: 0, raisons: [`source ${source.id} en pause (${source.derniereErreur ?? "sans raison tracée"})`], contradictions: 0 };
  }
  raisons.push(`provenance traçable : ${source.id} (${source.licence.slice(0, 60)})`);

  // 5. Dates — une collecte datée du futur est rejetée (horloge fausse).
  if (Date.parse(enr.provenance.collecteLe) > Date.now() + 60_000) {
    return { statut: "REJECTED", confiance: 0, raisons: [...raisons, "date de collecte dans le futur — horloge suspecte"], contradictions: 0 };
  }

  // 2. Qualité du contenu (mesurée au Lot 4).
  if (enr.qualite < QUALITE_MIN) {
    return { statut: "REJECTED", confiance: enr.qualite, raisons: [...raisons, `qualité ${enr.qualite} < ${QUALITE_MIN} — contenu indigeste`], contradictions: 0 };
  }

  // 3. Confirmation indépendante + 4. contradictions.
  const existante = memoire.obtenir(enr.idConcept);
  let contradictions = 0;
  let confirmations = 1 + Math.max(0, confirmationsQuarantaine); // la source courante
  if (existante) {
    const sourcesDistinctes = memoire.sourcesDe(existante.idConcept);
    if (sourcesDistinctes.filter((s) => s !== enr.provenance.sourceId).length > 0) confirmations += 1;
    if (confirmations >= 2) raisons.push(`confirmation indépendante : ${confirmations} sources distinctes`);
    // Propriétés incompatibles (même clé, valeurs différentes) — conservées.
    for (const p of enr.proprietes) {
      const autre = existante.proprietes.find((e) => e.cle === p.cle && e.valeur !== p.valeur);
      if (autre) {
        contradictions += 1;
        raisons.push(`contradiction conservée sur « ${p.cle} » (2 versions en mémoire)`);
      }
    }
  }

  // 6-7. Confiance mesurée + décision : 0.7 en source unique, OU ≥ 2 sources.
  const confiance = Math.min(
    1,
    enr.qualite * 0.4 + Math.min(1, confirmations / 2) * 0.45 + (enr.domaine ? 0.15 : 0),
  );
  if (confirmations >= 2 || confiance >= 0.7) {
    raisons.push(
      confirmations >= 2
        ? `intégration autorisée : ${confirmations} sources indépendantes`
        : `confiance ${confiance} ≥ 0.7 (source unique de haute qualité) — intégration autorisée`,
    );
    return { statut: "APPROVED", confiance, raisons, contradictions };
  }
  raisons.push(`confiance ${confiance} < 0.7 et source unique — mise en QUARANTAINE (promue si une seconde source confirme)`);
  return { statut: "QUARANTINED", confiance, raisons, contradictions };
}
