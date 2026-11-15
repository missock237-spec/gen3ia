import "server-only";

import { randomUUID } from "node:crypto";

import type { AIProvider, AIRequest, TaskType } from "@/lib/ai/models";
import { selectProvider } from "@/lib/ai/router";
import { paymentRequired } from "@/lib/security/http-errors";

import { estimateExecutionCost, eurToMinor } from "./cost-engine";
import {
  runWithExecutionMeter,
  type ExecutionCostAccumulator,
} from "./execution-meter";
import { getWallet, releaseReservation, reserveFunds, settleReservation, WALLET_CURRENCY } from "./wallet";

/**
 * PORTILLON DE FACTURATION (Task 153 — paiement à chaque exécution d'agent IA).
 *
 * Exigence produit : AVANT TOUTE exécution d'agent IA, le projet calcule le
 * coût de la requête et le DÉDUIT du solde de l'utilisateur ; le coût
 * d'utilisation dépend des COÛTS EXTERNES réels (tokens fournisseur, médias,
 * outils tiers) AUQUEL s'ajoute la marge du projet (GEN3IA_PLATFORM_MARGIN_RATE).
 *
 * Cycle complet garanti par ce module, pour chaque requête :
 *  1. ESTIMATION du pire cas (tarifs du cost-engine, multi-fournisseurs) ;
 *  2. RÉSERVATION atomique sur le portefeuille — solde insuffisant →
 *     HttpError 402 PAYMENT_REQUIRED AVANT qu'aucun token ne soit consommé ;
 *  3. EXÉCUTION dans un contexte de comptage (AsyncLocalStorage) : chaque
 *     appel LLM de la descendance (planner, critique, synthèse…) et chaque
 *     coût externe explicite est accumulé au réel ;
 *  4. RÈGLEMENT au coût réel constaté (plafonné à la réservation) — la
 *     différence est implicitement restituée au solde disponible ;
 *  5. ÉCHEC de l'exécution → LIBÉRATION de la réservation (jamais payé
 *     pour un crash), l'erreur d'origine remonte intacte.
 *
 * L'appel LLM déjà facturé par generateForUser() (missions du runner) porte
 * un marqueur « self-billed » : il est ignoré par le compteur pour éviter la
 * double facturation.
 */

/** Plafond de réservation par exécution (EUR) — évite de bloquer un solde entier. */
const MAX_RESERVE_EUR_DEFAULT = 10;
/** Nombre maximal d'appels LLM couverts par une seule réservation. */
const MAX_CALLS_PER_EXECUTION = 12;

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Estimation d'exécution fournie par la route (pire cas d'UNE interaction utilisateur). */
export interface ExecutionEstimateInput {
  task: TaskType;
  provider?: AIProvider;
  model?: string;
  /** Tokens d'entrée attendus (message + historique + système), conservateurs. */
  inputTokens?: number;
  /** Tokens de sortie maximum demandés (maxTokens). */
  outputTokens?: number;
  complexity?: number;
  toolCalls?: number;
  /** Coût externe connu à l'avance (génération d'image, service tiers…), en EUR. */
  externalToolCostEur?: number;
  /** Nombre d'appels LLM attendus dans cette exécution (classification + plan + synthèse…). */
  calls?: number;
}

/** Résumé de facturation renvoyé à la route (serialisable dans la réponse). */
export interface ExecutionBillingSummary {
  label: string;
  currency: string;
  /** Montant réellement débité (unités mineures). */
  chargeMinor: number;
  /** Montant qui avait été réservé avant exécution. */
  reservedMinor: number;
  /** Coût externe consommé (EUR) — tokens + outils + médias. */
  providerCostEur: number;
  /** Marge projet perçue (EUR). */
  marginEur: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  models: string[];
  durationMs: number;
}

function insufficientFundsMessage(neededMinor: number, availableMinor: number, currency: string): string {
  const needed = (neededMinor / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  const available = Math.max(0, availableMinor / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  return `Solde insuffisant pour exécuter cette requête : environ ${needed} ${currency} requis, ${available} ${currency} disponible. Rechargez votre portefeuille Gen3ia pour continuer.`;
}

function isInsufficientFunds(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /insufficient (wallet )?balance|wallet balance is 0/i.test(message);
}

/**
 * Pire coût de réservation : tarifs du cost-engine évalués sur TOUS les
 * fournisseurs capables d'exécuter la tâche (le routage réel peut tomber sur
 * n'importe lequel — le repli doit être couvert), multipliés par le nombre
 * d'appels LLM attendus, puis plafonnés (MAX_RESERVE_EUR) pour ne jamais
 * immobiliser un solde disproportionné.
 */
function worstCaseReserveMinor(estimate: ExecutionEstimateInput): number {
  const calls = Math.max(1, Math.min(MAX_CALLS_PER_EXECUTION, Math.floor(estimate.calls ?? 1)));
  const inputTokens = Math.max(0, estimate.inputTokens ?? 0) * calls;
  const outputTokens = Math.max(0, estimate.outputTokens ?? 0) * calls;
  const toolCalls = Math.max(0, estimate.toolCalls ?? 0) * calls;

  let candidates: Array<{ provider: AIProvider; model: string }> = [];
  try {
    const probe = {
      task: estimate.task,
      messages: [{ role: "user" as const, content: "billing estimate" }],
      ...(estimate.provider ? { provider: estimate.provider } : {}),
      ...(estimate.model ? { model: estimate.model } : {}),
    } as unknown as AIRequest;
    candidates = selectProvider(probe).map((decision) => ({ provider: decision.provider, model: decision.model }));
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    candidates = [{ provider: estimate.provider ?? ("openrouter" as AIProvider), model: estimate.model ?? "auto" }];
  }

  let worst = 0;
  for (const candidate of candidates) {
    const breakdown = estimateExecutionCost({
      task: estimate.task,
      provider: candidate.provider,
      model: candidate.model,
      inputTokens,
      outputTokens,
      complexity: estimate.complexity,
      toolCalls,
      externalToolCostEur: estimate.externalToolCostEur,
    });
    if (Number.isFinite(breakdown.reserveMinor)) worst = Math.max(worst, breakdown.reserveMinor);
  }

  // Garde-fous : estimation non finie → repli 100 minor ; plafond anti-blocage.
  if (!Number.isSafeInteger(worst) || worst < 1) worst = 100;
  const capMinor = Math.max(100, eurToMinor(envNumber("GEN3IA_MAX_EXECUTION_RESERVE_EUR", MAX_RESERVE_EUR_DEFAULT)));
  return Math.min(worst, capMinor);
}

/**
 * Exécute `fn` derrière le portillon de facturation : réservation avant
 * exécution, règlement au réel après, libération sur échec. Solde
 * insuffisant → HttpError 402 AVANT que `fn` ne démarre.
 */
export async function runWithExecutionBilling<T>(params: {
  userId: string;
  /** Libellé de traçabilité (ledger + réponse API). */
  label: string;
  executionId?: string;
  estimate: ExecutionEstimateInput;
  metadata?: Record<string, string>;
  fn: () => Promise<T>;
}): Promise<{ result: T; billing: ExecutionBillingSummary }> {
  const reserveMinor = worstCaseReserveMinor(params.estimate);
  const executionId = params.executionId?.trim() || randomUUID();
  const reference = `exec_${executionId}_${randomUUID()}`;

  // ── 1. RÉSERVATION (avant toute consommation) ─────────────────────────
  // Fail-closed sur SOLDE INSUFFISANT (402 avant tout token consommé) mais
  // fail-open sur PANNE D'INFRASTRUCTURE : une indisponibilité du wallet ne
  // bloque pas les agents (même philosophie que l'escrow de mission — la
  // perte éventuelle est journalisée, le règlement est simplement impossible).
  let reserved = true;
  try {
    await reserveFunds({
      userId: params.userId,
      amountMinor: reserveMinor,
      reference,
      metadata: {
        gate: params.label,
        task: params.estimate.task,
        executionId,
        ...(params.metadata ?? {}),
      },
    });
  } catch (error) {
    if (isInsufficientFunds(error)) {
      let availableMinor = 0;
      try {
        availableMinor = (await getWallet(params.userId)).availableMinor;
      } catch {
        availableMinor = 0;
      }
      throw paymentRequired(insufficientFundsMessage(reserveMinor, availableMinor, WALLET_CURRENCY));
    }
    reserved = false;
    console.error(
      "[execution-gate] réservation indisponible (fail-open, exécution non facturée) :",
      error instanceof Error ? error.message : error,
    );
  }

  // ── 2. EXÉCUTION sous compteur ───────────────────────────────────────
  const accumulator: ExecutionCostAccumulator = {
    label: params.label,
    startedAtMs: Date.now(),
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    providerCostEur: 0,
    marginEur: 0,
    chargeEur: 0,
    chargeMinor: 0,
    externalCostsEur: 0,
    models: new Set<string>(),
  };

  try {
    const result = await runWithExecutionMeter(accumulator, params.fn);

    // ── 3. RÈGLEMENT au réel (plafonné à la réservation) ────────────────
    // Le coût réel constaté ne peut jamais dépasser la réservation : la
    // difference au-delà est absorbée par la plateforme (contrat de
    // réservation — voir settleReservation).
    const actualChargeMinor = Math.max(0, Math.min(accumulator.chargeMinor, reserveMinor));
    // Fail-soft : le résultat de l'exécution ne doit JAMAIS être perdu pour
    // une panne de facturation (le règlement serait rejouable côté wallet).
    if (reserved) {
      try {
        await settleReservation({
          userId: params.userId,
          reference,
          reservedMinor: reserveMinor,
          actualChargeMinor,
          metadata: {
            gate: params.label,
            task: params.estimate.task,
            executionId,
            llmCalls: String(accumulator.llmCalls),
            inputTokens: String(accumulator.inputTokens),
            outputTokens: String(accumulator.outputTokens),
            providerCostEur: accumulator.providerCostEur.toFixed(6),
            marginEur: accumulator.marginEur.toFixed(6),
            ...(params.metadata ?? {}),
          },
        });
      } catch (settleError) {
        console.error("[execution-gate] règlement impossible (fail-soft) :", settleError instanceof Error ? settleError.message : settleError);
      }
    }

    return {
      result,
      billing: {
        label: params.label,
        currency: WALLET_CURRENCY,
        // Fail-open (pas de réservation) → rien n'a été débité.
        chargeMinor: reserved ? actualChargeMinor : 0,
        reservedMinor: reserveMinor,
        providerCostEur: accumulator.providerCostEur,
        marginEur: accumulator.marginEur,
        llmCalls: accumulator.llmCalls,
        inputTokens: accumulator.inputTokens,
        outputTokens: accumulator.outputTokens,
        models: [...accumulator.models],
        durationMs: Date.now() - accumulator.startedAtMs,
      },
    };
  } catch (error) {
    // ── 4. ÉCHEC → libération (jamais facturé) ──────────────────────────
    if (reserved) {
      await releaseReservation({
        userId: params.userId,
        reference,
        reservedMinor: reserveMinor,
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * SESSION DE FACTURATION À COMPLÉTION DIFFÉRÉE (Task 153) — variante du
 * portillon pour les réponses en FLUX : la réservation est prise AVANT le
 * début du flux (le client reçoit son 402 avant tout token), mais le
 * règlement n'intervient qu'à la FIN du travail asynchrone, quand la
 * réponse HTTP est déjà partie.
 *
 * Cycle : openExecutionBilling() → session.run(fn) pour chaque travail
 * compté (hérite du compteur) → session.settle() au succès (ou
 * session.release() sur échec/annulation).
 */
export interface ExecutionBillingSession {
  userId: string;
  label: string;
  reference: string;
  reserveMinor: number;
  accumulator: ExecutionCostAccumulator;
  /** Exécute un travail dans le contexte de comptage (le flux en hérite). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Règle au réel (plafonné à la réservation) — idempotent par sécurité. */
  settle(): Promise<ExecutionBillingSummary>;
  /** Libère la réservation (échec/annulation) — idempotent par sécurité. */
  release(): Promise<void>;
}

export async function openExecutionBilling(params: {
  userId: string;
  label: string;
  executionId?: string;
  estimate: ExecutionEstimateInput;
  metadata?: Record<string, string>;
}): Promise<ExecutionBillingSession> {
  const reserveMinor = worstCaseReserveMinor(params.estimate);
  const executionId = params.executionId?.trim() || randomUUID();
  const reference = `exec_${executionId}_${randomUUID()}`;

  // Fail-closed sur SOLDE INSUFFISANT, fail-open sur panne d'infrastructure
  // (cohérent avec runWithExecutionBilling et l'escrow de mission).
  let reserved = true;
  try {
    await reserveFunds({
      userId: params.userId,
      amountMinor: reserveMinor,
      reference,
      metadata: {
        gate: params.label,
        task: params.estimate.task,
        executionId,
        mode: "stream",
        ...(params.metadata ?? {}),
      },
    });
  } catch (error) {
    if (isInsufficientFunds(error)) {
      let availableMinor = 0;
      try {
        availableMinor = (await getWallet(params.userId)).availableMinor;
      } catch {
        availableMinor = 0;
      }
      throw paymentRequired(insufficientFundsMessage(reserveMinor, availableMinor, WALLET_CURRENCY));
    }
    reserved = false;
    console.error(
      "[execution-gate] réservation stream indisponible (fail-open) :",
      error instanceof Error ? error.message : error,
    );
  }

  const accumulator: ExecutionCostAccumulator = {
    label: params.label,
    startedAtMs: Date.now(),
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    providerCostEur: 0,
    marginEur: 0,
    chargeEur: 0,
    chargeMinor: 0,
    externalCostsEur: 0,
    models: new Set<string>(),
  };

  let settled = false;
  let released = false;

  const session: ExecutionBillingSession = {
    userId: params.userId,
    label: params.label,
    reference,
    reserveMinor,
    accumulator,
    run<T>(fn: () => Promise<T>): Promise<T> {
      return runWithExecutionMeter(accumulator, fn);
    },
    async settle(): Promise<ExecutionBillingSummary> {
      if (settled || released) {
        return summaryOf(session);
      }
      settled = true;
      if (!reserved) {
        return summaryOf(session);
      }
      const actualChargeMinor = Math.max(0, Math.min(accumulator.chargeMinor, reserveMinor));
      await settleReservation({
        userId: params.userId,
        reference,
        reservedMinor: reserveMinor,
        actualChargeMinor,
        metadata: {
          gate: params.label,
          task: params.estimate.task,
          executionId,
          mode: "stream",
          llmCalls: String(accumulator.llmCalls),
          inputTokens: String(accumulator.inputTokens),
          outputTokens: String(accumulator.outputTokens),
          providerCostEur: accumulator.providerCostEur.toFixed(6),
          marginEur: accumulator.marginEur.toFixed(6),
          ...(params.metadata ?? {}),
        },
      });
      return summaryOf(session);
    },
    async release(): Promise<void> {
      if (settled || released || !reserved) return;
      released = true;
      await releaseReservation({
        userId: params.userId,
        reference,
        reservedMinor: reserveMinor,
      }).catch(() => undefined);
    },
  };

  function summaryOf(current: ExecutionBillingSession): ExecutionBillingSummary {
    return {
      label: current.label,
      currency: WALLET_CURRENCY,
      chargeMinor: settled && reserved ? Math.max(0, Math.min(accumulator.chargeMinor, reserveMinor)) : 0,
      reservedMinor: current.reserveMinor,
      providerCostEur: accumulator.providerCostEur,
      marginEur: accumulator.marginEur,
      llmCalls: accumulator.llmCalls,
      inputTokens: accumulator.inputTokens,
      outputTokens: accumulator.outputTokens,
      models: [...accumulator.models],
      durationMs: Date.now() - accumulator.startedAtMs,
    };
  }

  return session;
}
