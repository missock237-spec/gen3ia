import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { AIRequest, AIResponse } from "@/lib/ai/models";

import { costFromAIResponse, estimateExecutionCost } from "./cost-engine";

/**
 * COMPTEUR DE COÛTS D'EXÉCUTION (Task 153 — paiement à la demande).
 *
 * Principe : TOUTE exécution d'agent IA démarre derrière un « portillon de
 * facturation » (lib/billing/execution-gate.ts) qui RÉSERVE d'abord le
 * pire coût estimé sur le portefeuille utilisateur, puis règle au réel à
 * la fin. Pour que le règlement reflète les COÛTS EXTERNES réellement
 * consommés (tokens, outils, médias), chaque appel LLM effectué PENDANT
 * l'exécution doit être comptabilisé.
 *
 * Ce module fournit ce compteur, porté par un AsyncLocalStorage : toute
 * fonction appelée (de près ou de loin) dans la descendance asynchrone de
 * la requête partage le même accumulateur — le routeur IA
 * (lib/ai/router.ts) enregistre chaque réponse au passage, sans que les
 * moteurs (planner, critique, synthèse, perception…) n'aient à connaître
 * la facturation.
 *
 * Aucune dépendance vers le routeur ici (le routeur importe ce module) :
 * la double facturation est évitée par un marqueur de métadonnées posé par
 * generateForUser() (lib/billing/ai-execution.ts) qui facture déjà ses
 * propres appels via sa propre réservation.
 *
 * Tout est FAIL-SOFT : une panne de comptage ne doit jamais faire échouer
 * une génération déjà payée — au pire le portillon règle la réservation.
 */

/** Clé/valeur de marqueur dans AIRequest.metadata : appel déjà facturé par ailleurs. */
export const SELF_BILLED_METADATA_KEY = "billing";
export const SELF_BILLED_METADATA_VALUE = "self-billed";

/** Accumulateur des coûts réels d'UNE exécution (unités monétaires : EUR interne, minor wallet). */
export interface ExecutionCostAccumulator {
  /** Libellé de l'exécution (ex. « chat-message », « conversation-turn »). */
  label: string;
  startedAtMs: number;
  /** Nombre d'appels LLM comptés. */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Somme des coûts EXTERNES fournisseur (tokens + outils externes), en EUR. */
  providerCostEur: number;
  /** Somme des marges plateforme appliquées, en EUR. */
  marginEur: number;
  /** Coût total chargé (externe + marge), en EUR. */
  chargeEur: number;
  /** Coût total chargé, en unités mineures du portefeuille (XAF × 100). */
  chargeMinor: number;
  /** Coûts externes additionnés manuellement (images, outils tiers), en EUR. */
  externalCostsEur: number;
  /** Modèles réellement utilisés, dédupliqués (« provider:model »). */
  models: Set<string>;
}

const meterStorage = new AsyncLocalStorage<ExecutionCostAccumulator>();

/** Accumulateur de l'exécution facturée en cours (undefined hors portillon). */
export function currentExecutionAccumulator(): ExecutionCostAccumulator | undefined {
  return meterStorage.getStore();
}

/** Exécute `fn` dans le contexte de comptage de l'accumulateur donné. */
export function runWithExecutionMeter<T>(accumulator: ExecutionCostAccumulator, fn: () => Promise<T>): Promise<T> {
  return meterStorage.run(accumulator, fn);
}

/** Un appel LLM déjà facturé par son propre canal (generateForUser) ne doit pas recompter ici. */
export function isSelfBilledRequest(request: AIRequest): boolean {
  return request?.metadata?.[SELF_BILLED_METADATA_KEY] === SELF_BILLED_METADATA_VALUE;
}

/**
 * Enregistre le coût RÉEL d'une réponse LLM dans l'exécution en cours.
 * Appelé par le routeur IA après CHAQUE generate()/generateStream()
 * réussi. Fail-soft total : hors exécution facturée ou erreur de calcul,
 * la génération n'est jamais impactée.
 */
export function recordLLMCallForBilling(request: AIRequest, response: AIResponse): void {
  try {
    const accumulator = meterStorage.getStore();
    if (!accumulator) return;
    if (isSelfBilledRequest(request)) return;
    const cost = costFromAIResponse(request, response);
    accumulator.llmCalls += 1;
    accumulator.inputTokens += Math.max(0, Number(response?.usage?.inputTokens ?? 0));
    accumulator.outputTokens += Math.max(0, Number(response?.usage?.outputTokens ?? 0));
    accumulator.providerCostEur += cost.providerCostEur;
    accumulator.marginEur += cost.marginEur;
    accumulator.chargeEur += cost.chargeEur;
    accumulator.chargeMinor += cost.chargeMinor;
    if (response?.provider) {
      accumulator.models.add(`${response.provider}:${response.model ?? "auto"}`);
    }
  } catch {
    // Le comptage ne doit jamais casser une génération réussie.
  }
}

/**
 * Ajoute un coût EXTERNE ponctuel (génération d'image, service tiers…)
 * à l'exécution en cours. La marge plateforme est appliquée au même taux
 * que le reste de la facturation (estimateExecutionCost) : le coût chargé
 * n'est pas le coût externe brut.
 */
export function recordExternalCostForBilling(params: { eur: number; label?: string }): void {
  try {
    const accumulator = meterStorage.getStore();
    if (!accumulator) return;
    const eur = Math.max(0, Number(params.eur ?? 0));
    if (!Number.isFinite(eur) || eur <= 0) return;
    const cost = estimateExecutionCost({
      task: "automation",
      externalToolCostEur: eur,
      toolCalls: 1,
      complexity: 1,
    });
    accumulator.externalCostsEur += eur;
    accumulator.providerCostEur += eur;
    accumulator.marginEur += cost.marginEur;
    accumulator.chargeEur += cost.chargeEur;
    accumulator.chargeMinor += cost.chargeMinor;
    if (params.label) accumulator.models.add(params.label);
  } catch {
    // Fail-soft : idem recordLLMCallForBilling.
  }
}
