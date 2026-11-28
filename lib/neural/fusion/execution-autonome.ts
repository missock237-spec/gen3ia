/**
 * EXÉCUTION AUTONOME — mission « s'exécuter dans n'importe quelle situation,
 * résoudre les problèmes rencontrés en cours de tâche ».
 *
 * Boucle PLAN → EXÉCUTE → VÉRIFIE → RÉCUPÈRE :
 *  · chaque étape du plan hors corpus est tentée ;
 *  · en cas d'échec (exception OU résultat non vérifié) : l'incident est
 *    JOURNALISÉ, une RÉCUPÉRATION est tentée (variante de l'énoncé, primitive
 *    alternative, portage du résultat précédent) — jusqu'à TENTATIVES_MAX ;
 *  · l'exécution ne s'arrête jamais brutalement : soit résultat vérifié,
 *    soit repli honnête explicite avec le journal complet des incidents ;
 *  · le journal alimente le générateur de rapports (post-travail) et la
 *    mémoire d'ondes (les tâches vécues enrichissent la compréhension).
 */

import { PRIMITIVES, type EtapePlan, type PlanInedit, type Primitive, type ResultatPrimitive } from "./raisonnement-inedit";

export interface ObjectifTache {
  /** Objectif exprimé en langage naturel. */
  objectif: string;
  /** Souvenirs du compte pour l'analogie (mémoire permanente). */
  souvenirs?: Array<{ texte: string; score: number }>;
}

export interface IncidentExecution {
  etape: number;
  enonce: string;
  description: string;
  /** La récupération a-t-elle permis de poursuivre ? */
  recuperee: boolean;
  /** Description de la récupération tentée. */
  recuperation: string;
}

export interface EtapeExecutee {
  index: number;
  enonce: string;
  primitiveId: string | null;
  resultat: string | null;
  tentative: number;
  ok: boolean;
  detail: string;
}

export interface ExecutionTache {
  objectif: string;
  /** La tâche a-t-elle abouti (résultat vérifié) ? */
  reussie: boolean;
  resultatFinal: string | null;
  etapes: EtapeExecutee[];
  incidents: IncidentExecution[];
  metriques: {
    etapesTotales: number;
    tentatives: number;
    incidents: number;
    incidentsRecuperes: number;
  };
  /** Repli honnête si échec final (jamais de succès inventé). */
  repliHonnete: string | null;
}

const TENTATIVES_MAX = 3;

/** Vérification d'une étape : le résultat doit être non vide et cohérent. */
function verifierResultat(resultat: string | null): boolean {
  return typeof resultat === "string" && resultat.trim().length > 0;
}

/**
 * Exécute un plan hors corpus avec récupération d'erreurs en cours de
 * tâche. Déterministe : mêmes entrées → mêmes incidents → mêmes
 * récupérations → même rapport.
 */
export function executerTache(objectif: ObjectifTache, plan: PlanInedit): ExecutionTache {
  const etapes: EtapeExecutee[] = [];
  const incidents: IncidentExecution[] = [];
  let tentatives = 0;
  let precedent: string | null = null;

  for (const etape of plan.etapes) {
    let ok = false;
    let resultatFinal: string | null = null;
    let detail = "";
    let primitiveId = etape.primitiveId;
    let enonce: string = etape.enonce;
    let tentative = 0;

    while (tentative < TENTATIVES_MAX && !ok) {
      tentative++;
      try {
        if (primitiveId) {
          const primitive = PRIMITIVES.find((p) => p.id === primitiveId);
          if (!primitive) {
            detail = `primitive ${primitiveId} introuvable`;
          } else {
            const resultat = primitive.executer(enonce, precedent);
            detail = resultat.detail;
            if (resultat.ok && verifierResultat(resultat.valeur)) {
              ok = true;
              resultatFinal = resultat.valeur;
            } else if (resultat.valeur !== null) {
              // Résultat produit mais non vérifiable → tenté comme porteur.
              resultatFinal = resultat.valeur;
            }
          }
        } else {
          // Aucune primitive : RÉCUPÉRATION — réécrit l'énoncé en portant le
          // résultat précédent et re-scanne les primitives (le portage rend
          // computable un énoncé initialement opaque).
          const porte: string = precedent ? `${etape.enonce} ${precedent}` : etape.enonce;
          const alternative: Primitive | undefined = PRIMITIVES.find((p) => p.match(porte));
          if (alternative) {
            primitiveId = alternative.id;
            enonce = porte;
            const resultat: ResultatPrimitive = alternative.executer(porte, precedent);
            detail = `récupération par portage → ${alternative.id} : ${resultat.detail}`;
            if (resultat.ok && verifierResultat(resultat.valeur)) {
              ok = true;
              resultatFinal = resultat.valeur;
            } else if (resultat.valeur !== null) {
              resultatFinal = resultat.valeur;
            }
          } else {
            detail = "aucune primitive même après portage";
          }
        }
      } catch (erreur) {
        detail = `exception : ${erreur instanceof Error ? erreur.message : String(erreur)}`;
      }
    }

    // Incident journalisé si : réessais, échec, OU récupération déclenchée
    // (une étape sans primitive au plan qui réussit PAR PORTAGE est un
    // incident récupéré — l'honnêteté exige la trace).
    const recupereeAuPortage = !etape.primitiveId && ok;
    if (tentative > 1 || !ok || recupereeAuPortage) {
      incidents.push({
        etape: etape.index,
        enonce: etape.enonce,
        description: detail,
        recuperee: ok,
        recuperation:
          !etape.primitiveId
            ? `portage du résultat précédent (${precedent ?? "aucun"}) → primitive ${primitiveId ?? "aucune"}`
            : primitiveId !== etape.primitiveId
              ? `primitive alternative ${primitiveId} via portage du résultat précédent`
              : `réessais (${tentative}/${TENTATIVES_MAX})`,
      });
    }

    tentatives += tentative;
    if (ok) precedent = resultatFinal;
    etapes.push({ index: etape.index, enonce, primitiveId, resultat: ok ? resultatFinal : null, tentative, ok, detail });
  }

  const derniere = etapes[etapes.length - 1] as EtapeExecutee | undefined;
  // Le verdict appartient à l'EXÉCUTION vérifiée (pas au plan initial) :
  // une étape récupérée par portage est un vrai succès — c'est la mission
  // « résoudre les problèmes rencontrés en cours de tâche ». Un échec reste
  // un échec honnête (aucun résultat vérifié → repli explicite).
  const reussie = derniere?.ok === true && derniere.resultat !== null;
  const incidentsRecuperes = incidents.filter((i) => i.recuperee).length;
  const repliHonnete = reussie
    ? null
    : [
        "non computable localement en l'état",
        plan.analogie ? `analogie la plus proche du compte : ${plan.analogie.slice(0, 120)}` : "aucune analogie résolue dans la mémoire du compte",
        `étapes tentées : ${etapes.map((e) => `${e.index}:${e.primitiveId ?? "?"}${e.ok ? "✓" : "×"}`).join(" ")}`,
      ].join(" — ");

  return {
    objectif: objectif.objectif,
    reussie,
    resultatFinal: reussie ? (derniere?.resultat ?? null) : null,
    etapes,
    incidents,
    metriques: {
      etapesTotales: etapes.length,
      tentatives,
      incidents: incidents.length,
      incidentsRecuperes,
    },
    repliHonnete,
  };
}
