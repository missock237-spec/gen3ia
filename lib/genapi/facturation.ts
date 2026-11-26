/**
 * GENAPI FACTURATION — comptabilisation par application (mission PHASE 6)
 * sur la facturation au portefeuille RÉELLE existante (lib/billing/api-usage
 * : tokens mesurés, réservation → exécution → règlement) + IDEMPOTENCE
 * (PHASE 6-10 : rejouer la même opération de facturation est sans effet —
 * clé d'idempotence par application).
 */

import { computeApiTokenCharge, API_USAGE_FORMULA, type ApiTokenCharge } from "@/lib/billing/api-usage";
import type { ServiceGenapi } from "./services";

export { API_USAGE_FORMULA }; // tarifs exposés aux développeurs (PHASE 8 docs)

export interface ConsommationGenapi {
  id: string;
  applicationId: string;
  service: ServiceGenapi;
  /** Clé d'idempotence fournie par l'appelant (Idempotency-Key HTTP). */
  cleIdempotence: string;
  tokens: ApiTokenCharge;
  dureeMs: number;
  /** Volume de données traitées (octets utiles réels de la requête). */
  octets: number;
  horodatage: number;
}

const globalFact = globalThis as typeof globalThis & {
  __gen3iaGenapiConso?: Map<string, ConsommationGenapi>; // clé : app|cleIdempotence
  __gen3iaGenapiBudgetJour?: Map<string, { jour: string; microEur: number }>;
};

function consos(): Map<string, ConsommationGenapi> {
  if (!globalFact.__gen3iaGenapiConso) globalFact.__gen3iaGenapiConso = new Map();
  return globalFact.__gen3iaGenapiConso;
}

function budgets(): Map<string, { jour: string; microEur: number }> {
  if (!globalFact.__gen3iaGenapiBudgetJour) globalFact.__gen3iaGenapiBudgetJour = new Map();
  return globalFact.__gen3iaGenapiBudgetJour;
}

export type ResultatFacturation =
  | { statut: "enregistree"; consommation: ConsommationGenapi }
  | { statut: "deja-facturee"; consommation: ConsommationGenapi; note: "idempotence : cette clé a déjà été réglée, aucun double débit" }
  | { statut: "budget-atteint"; budgetMicroEur: number; cumulMicroEur: number };

/** Enregistre une consommation — IDEMPOTENT par (application, clé). */
export function facturerConsommation(entree: {
  applicationId: string;
  service: ServiceGenapi;
  cleIdempotence: string;
  inputTokens: number;
  outputTokens: number;
  dureeMs: number;
  octets: number;
  budgetJournalierMicroEur: number;
}): ResultatFacturation {
  const cle = `${entree.applicationId}|${entree.cleIdempotence}`;
  const existante = consos().get(cle);
  if (existante) return { statut: "deja-facturee", consommation: existante, note: "idempotence : cette clé a déjà été réglée, aucun double débit" };

  const tokens = computeApiTokenCharge({ inputTokens: entree.inputTokens, outputTokens: entree.outputTokens });
  const jour = new Date().toISOString().slice(0, 10);
  const budget = budgets().get(entree.applicationId);
  const cumul = budget && budget.jour === jour ? budget.microEur : 0;
  const microEur = tokens.chargeMicroEur; // champ réel de lib/billing/api-usage
  if (cumul + microEur > entree.budgetJournalierMicroEur) {
    // PHASE 6-9 : consommation NON AUTORISÉE refusée AVANT enregistrement.
    return { statut: "budget-atteint", budgetMicroEur: entree.budgetJournalierMicroEur, cumulMicroEur: cumul };
  }
  const consommation: ConsommationGenapi = {
    id: `conso_${crypto.randomUUID().slice(0, 14)}`,
    applicationId: entree.applicationId,
    service: entree.service,
    cleIdempotence: entree.cleIdempotence,
    tokens,
    dureeMs: entree.dureeMs,
    octets: entree.octets,
    horodatage: Date.now(),
  };
  consos().set(cle, consommation);
  budgets().set(entree.applicationId, { jour, microEur: cumul + microEur });
  return { statut: "enregistree", consommation };
}

/** Cumul journalier réel d'une application (portail PHASE 7). */
export function cumulJournalier(applicationId: string): { jour: string; microEur: number; operations: number } {
  const jour = new Date().toISOString().slice(0, 10);
  let microEur = 0;
  let operations = 0;
  for (const c of consos().values()) {
    if (c.applicationId === applicationId && new Date(c.horodatage).toISOString().slice(0, 10) === jour) {
      microEur += c.tokens.chargeMicroEur;
      operations++;
    }
  }
  return { jour, microEur, operations };
}

/** Historique de consommation d'une application (mission PHASE 6). */
export function historiqueConsommation(applicationId: string, limite = 100): ConsommationGenapi[] {
  return [...consos().values()]
    .filter((c) => c.applicationId === applicationId)
    .sort((a, b) => b.horodatage - a.horodatage)
    .slice(0, limite);
}
