import "server-only";

import { randomUUID } from "node:crypto";

import { paymentRequired } from "@/lib/security/http-errors";

import { eurToXafRate } from "./cost-engine";
import { BILLING_ENABLED } from "./billing-mode";
import { releaseReservation, reserveFunds, settleReservation, WALLET_CURRENCY } from "./wallet";

/**
 * FACTURATION DE L'USAGE API PAR CLÉ `g3a_` (clés API entreprise) —
 * demande utilisateur n°9 : chaque appel API authentifié PAR CLÉ API est
 * facturé à son propriétaire :
 *
 *   - 1,00 €  par million de tokens ENTRANTS (prompt) ;
 *   - 1,50 €  par million de tokens SORTANTS (génération).
 *
 * FORMULE EXACTE (entiers, déterministe, aucune perte d'arrondi flottant) :
 *
 *   1. nano-euros (1 € = 1 000 000 000 nano€) — tarifs exacts en entiers :
 *        entrant  = tokens_in  × 1000 nano€   (1,00 € / 1 000 000 tokens)
 *        sortant  = tokens_out × 1500 nano€   (1,50 € / 1 000 000 tokens)
 *   2. micro-euros : chargeMicroEur = ceil((entrant + sortant) / 1000)
 *      (arrondi AU micro-euro SUPÉRIEUR — déterministe, favorable plateforme,
 *      la proratisation par token reste exacte en nano€) ;
 *   3. unités mineures du portefeuille (XAF × 100, parité fixe CFA —
 *      même taux que le cost-engine, GEN3IA_EUR_TO_XAF) :
 *        chargeMinor = ceil(chargeMicroEur × taux / 10 000) — calculé en
 *      BigInt (aucun arrondi flottant intermédiaire).
 *
 * COMPTAGE DES TOKENS (honnêteté stricte) :
 *   - les tokens MESURÉS proviennent des usage reports réels du moteur
 *     (state.billing.llmInputTokens / llmOutputTokens du runtime) ; le
 *     moteur SNN rapporte les mots réels du prompt et de la réponse
 *     (estimation documentée dans lib/neural/engine.ts — un SNN ne possède
 *     pas de tokenizer LLM) ;
 *   - l'ESTIMATION de RÉSERVATION (avant exécution) est calculée par
 *     estimateTokensFromText (≈ caractères / 4) : elle est TOUJOURS
 *     présentée comme estimation, jamais comme mesure.
 *
 * CYCLE FINANCIER (politique existante du wallet, identique au portillon
 * d'exécution lib/billing/execution-gate.ts) :
 *   1. RÉSERVATION de l'estimation AVANT l'exécution — solde insuffisant →
 *      HttpError 402 AVANT qu'aucun token ne soit consommé ;
 *   2. EXÉCUTION ;
 *   3. RÈGLEMENT au RÉEL mesuré (plafonné à la réservation — au-delà, la
 *      différence est absorbée par la plateforme, contrat de réservation
 *      identique au portillon ; le sous-débord éventuel reste traçable :
 *      tokens mesurés + montants sont journalisés dans le ledger) ;
 *   4. ÉCHEC de l'exécution → LIBÉRATION (jamais payé pour un crash).
 *
 * MODE LIBRE (GEN3IA_BILLING_ENABLED absent ou ≠ « true », défaut de
 * production Task 161) : aucune réservation, aucun débit, aucun blocage —
 * le comptage et la tarification restent calculés au réel et renvoyés
 * dans la réponse API (transparence), mais le wallet n'est jamais touché.
 */

/** Tarif officiel : 1,00 € par million de tokens ENTRANTS. */
export const API_TOKEN_INPUT_EUR_PER_MILLION = 1;
/** Tarif officiel : 1,50 € par million de tokens SORTANTS. */
export const API_TOKEN_OUTPUT_EUR_PER_MILLION = 1.5;

/** Tarifs en nano-euros PAR TOKEN (entiers exacts : 1 €/1M = 1000 nano€/token). */
export const API_INPUT_NANO_EUR_PER_TOKEN = 1000;
export const API_OUTPUT_NANO_EUR_PER_TOKEN = 1500;

/** Formule documentée, exposée telle quelle dans les réponses API. */
export const API_USAGE_FORMULA =
  "micro€ = ceil((tokens_in × 1000 + tokens_out × 1500) / 1000) ; " +
  "minor(XAF×100) = ceil(micro€ × GEN3IA_EUR_TO_XAF / 10000) ; " +
  "tarifs : 1,00 €/1M tokens entrant, 1,50 €/1M tokens sortant";

/** Note de mesure honnête, exposée dans les réponses API. */
export const API_USAGE_MEASUREMENT_NOTE =
  "tokens mesurés = usage reports réels du moteur (le SNN rapporte les mots " +
  "réels du prompt et de la réponse — estimation documentée, faute de " +
  "tokenizer LLM) ; la réservation préalable est une ESTIMATION (≈ caractères/4).";

/** Taux EUR→XAF en BigInt (précision 1e-6), source unique cost-engine. */
const EUR_XAF_SCALE = BigInt(Math.round(eurToXafRate() * 1_000_000));
const MINOR_DENOMINATOR = 10_000n * 1_000_000n; // micro€ × taux / 10 000 → (× 1e6 des deux côtés)

/** Normalise un comptage de tokens : entier ≥ 0 sûr, sinon 0 (jamais négatif). */
function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), Number.MAX_SAFE_INTEGER);
}

/**
 * Convertit un montant en micro-euros en unités mineures du portefeuille
 * (XAF × 100), arrondi au supérieur, en BigInt (zéro erreur d'arrondi flottant).
 */
export function microEurToWalletMinor(microEur: number): number {
  if (!Number.isSafeInteger(microEur) || microEur <= 0) return 0;
  const scaled = BigInt(microEur) * EUR_XAF_SCALE;
  return Number((scaled + MINOR_DENOMINATOR - 1n) / MINOR_DENOMINATOR);
}

/** Tarification complète d'un usage API (pure, déterministe, entiers). */
export interface ApiTokenCharge {
  inputTokens: number;
  outputTokens: number;
  /** Nano-euros (1 € = 1e9) : entiers EXACTS, aucune proratisation perdue. */
  inputNanoEur: number;
  outputNanoEur: number;
  totalNanoEur: number;
  /** Micro-euros facturés (arrondi supérieur du total nano). */
  chargeMicroEur: number;
  /** Montant débitable en unités mineures du portefeuille (XAF × 100). */
  chargeMinor: number;
  currency: string;
}

/** Calcule la charge EXACTE d'un usage tokens (tarifs officiels 1 €/1M in, 1,50 €/1M out). */
export function computeApiTokenCharge(input: { inputTokens: number; outputTokens: number }): ApiTokenCharge {
  const inputTokens = normalizeTokenCount(input?.inputTokens);
  const outputTokens = normalizeTokenCount(input?.outputTokens);
  const inputNanoEur = inputTokens * API_INPUT_NANO_EUR_PER_TOKEN;
  const outputNanoEur = outputTokens * API_OUTPUT_NANO_EUR_PER_TOKEN;
  const totalNanoEur = inputNanoEur + outputNanoEur;
  const chargeMicroEur = Math.ceil(totalNanoEur / 1000);
  return {
    inputTokens,
    outputTokens,
    inputNanoEur,
    outputNanoEur,
    totalNanoEur,
    chargeMicroEur,
    chargeMinor: microEurToWalletMinor(chargeMicroEur),
    currency: WALLET_CURRENCY,
  };
}

/**
 * ESTIMATION DOCUMENTÉE (jamais présentée comme mesurée) : tokens ≈
 * caractères / 4 — approximation usuelle texte latin, appliquée uniquement
 * à la RÉSERVATION préalable.
 */
export function estimateTokensFromText(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

// Paramètres de l'estimation de réservation d'un run d'agent via API :
// le runtime enchaîne plusieurs appels LLM (plan, étapes, critique,
// synthèse) — l'estimation couvre un pire cas raisonnable, plafonné.
const ESTIMATE_MIN_INPUT_TOKENS_PER_CALL = 2000;
const ESTIMATE_OUTPUT_TOKENS_PER_CALL = 4096;
const ESTIMATE_LLM_CALLS = 6;
const RESERVE_FLOOR_MINOR = 100;
const RESERVE_CAP_EUR = 10;

/**
 * Réservation estimée (minor) pour un run d'agent API : tarifs officiels
 * appliqués à (max(estimation objective, plancher) × appels attendus) en
 * entrée et un plafond de génération par appel en sortie — bornée entre un
 * plancher et un plafond (jamais plus de RESERVE_CAP_EUR immobilisés).
 */
export function estimateApiRunReserveMinor(objective: string): number {
  const inputPerCall = Math.max(estimateTokensFromText(objective), ESTIMATE_MIN_INPUT_TOKENS_PER_CALL);
  const estimate = computeApiTokenCharge({
    inputTokens: inputPerCall * ESTIMATE_LLM_CALLS,
    outputTokens: ESTIMATE_OUTPUT_TOKENS_PER_CALL * ESTIMATE_LLM_CALLS,
  });
  const capMinor = microEurToWalletMinor(RESERVE_CAP_EUR * 1_000_000);
  return Math.min(Math.max(estimate.chargeMinor, RESERVE_FLOOR_MINOR), capMinor);
}

/** Résultat de facturation d'un appel API (serialisable dans la réponse). */
export interface ApiUsageBillingResult {
  /** true si un débit RÉEL a été appliqué au portefeuille. */
  billed: boolean;
  billingEnabled: boolean;
  measuredTokens: { inputTokens: number; outputTokens: number };
  /** Tarification réelle déterministe (nano€/micro€/minor + montants). */
  charge: Omit<ApiTokenCharge, "currency"> & { currency: string };
  /** Montant réellement débité (0 en mode libre ou charge nulle). */
  debitedMinor: number;
  /** Réservation qui avait été prise avant exécution (0 en mode libre). */
  reservedMinor: number;
  /** Part éventuellement absorbée par la plateforme (charge > réservation). */
  platformAbsorbedMinor: number;
  currency: string;
  measurementNote: string;
  formula: string;
}

/**
 * Exécute `fn` derrière le cycle de facturation tokens des appels API :
 * réservation estimée AVANT (402 si solde insuffisant), règlement au RÉEL
 * mesuré APRÈS, libération sur échec. `measure(result)` extrait les tokens
 * MESURÉS du résultat — seuls ces tokens sont tarifés.
 */
export async function runWithApiTokenBilling<T>(params: {
  userId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  /** Endpoint consommé (label du ledger, ex. « POST /api/v1/agents/{agentId}/run »). */
  endpoint: string;
  objective: string;
  executionId?: string;
  fn: () => Promise<T>;
  measure: (result: T) => { inputTokens: number; outputTokens: number };
}): Promise<{ result: T; usage: ApiUsageBillingResult }> {
  const executionId = params.executionId?.trim() || randomUUID();
  const reference = `api_${executionId}`;
  const metadata = {
    source: "api_usage",
    apiKeyId: params.apiKeyId,
    apiKeyPrefix: params.apiKeyPrefix,
    endpoint: params.endpoint,
    executionId,
  };

  // ── 1. RÉSERVATION estimée (402 AVANT toute consommation) ──────────────
  // Fail-closed sur SOLDE INSUFFISANT, fail-open sur panne d'infrastructure
  // wallet (même philosophie que le portillon : une indisponibilité ne
  // bloque pas l'exécution, la perte éventuelle est journalisée).
  let reserved = false;
  let reservedMinor = 0;
  if (BILLING_ENABLED) {
    reservedMinor = estimateApiRunReserveMinor(params.objective);
    try {
      await reserveFunds({ userId: params.userId, amountMinor: reservedMinor, reference, metadata });
      reserved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (/insufficient|wallet balance is 0/i.test(message)) {
        throw paymentRequired(
          `Solde insuffisant pour l'appel API : environ ${(reservedMinor / 100).toLocaleString("fr-FR")} ${WALLET_CURRENCY} requis (ESTIMATION de réservation, réglé au réel ensuite), solde insuffisant. Rechargez votre portefeuille Gen3ia (tarifs API : 1,00 €/1M tokens entrant, 1,50 €/1M sortant).`,
        );
      }
      console.error(
        "[api-usage] réservation indisponible (fail-open, appel non facturé) :",
        message,
      );
    }
  }

  // ── 2. EXÉCUTION ────────────────────────────────────────────────────────
  try {
    const result = await params.fn();
    const measured = params.measure(result);
    const charge = computeApiTokenCharge(measured);

    // ── 3. RÈGLEMENT au réel mesuré (plafonné à la réservation) ──────────
    let debitedMinor = 0;
    let platformAbsorbedMinor = 0;
    if (reserved) {
      const actualChargeMinor = Math.min(charge.chargeMinor, reservedMinor);
      platformAbsorbedMinor = Math.max(0, charge.chargeMinor - reservedMinor);
      debitedMinor = actualChargeMinor;
      try {
        await settleReservation({
          userId: params.userId,
          reference,
          reservedMinor,
          actualChargeMinor,
          metadata: {
            ...metadata,
            inputTokens: String(charge.inputTokens),
            outputTokens: String(charge.outputTokens),
            chargeMicroEur: String(charge.chargeMicroEur),
            chargeNanoEur: String(charge.totalNanoEur),
            platformAbsorbedMinor: String(platformAbsorbedMinor),
            tariff: "1EUR_per_1M_input_1.5EUR_per_1M_output",
          },
        });
      } catch (settleError) {
        // Fail-soft : le résultat de l'exécution n'est jamais perdu pour une
        // panne de facturation (l'écart reste traçable côté wallet).
        console.error(
          "[api-usage] règlement impossible (fail-soft) :",
          settleError instanceof Error ? settleError.message : settleError,
        );
      }
    }

    return {
      result,
      usage: {
        billed: reserved && debitedMinor > 0,
        billingEnabled: BILLING_ENABLED,
        measuredTokens: {
          inputTokens: charge.inputTokens,
          outputTokens: charge.outputTokens,
        },
        charge,
        debitedMinor,
        reservedMinor: reserved ? reservedMinor : 0,
        platformAbsorbedMinor,
        currency: WALLET_CURRENCY,
        measurementNote: API_USAGE_MEASUREMENT_NOTE,
        formula: API_USAGE_FORMULA,
      },
    };
  } catch (error) {
    // ── 4. ÉCHEC → libération (jamais payé pour un crash) ────────────────
    if (reserved) {
      await releaseReservation({ userId: params.userId, reference, reservedMinor }).catch(() => undefined);
    }
    throw error;
  }
}
