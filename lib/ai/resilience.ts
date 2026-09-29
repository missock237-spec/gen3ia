import "server-only";

/**
 * RÉSILIENCE ÉLASTIQUE (Task 42, axe 8).
 *
 * 1. COUPE-CIRCUIT PAR FOURNISSEUR : un provider qui échoue en rafale est
 *    mis au repos (open) pendant un cooldown croissant — les requêtes
 *    suivantes partent directement vers les autres fournisseurs (latence
 *    p99 préservée en cas d'incident chez l'un d'eux). Après cooldown, un
 *    essai unique (half-open) sonde le rétablissement. Si TOUS les
 *    fournisseurs sont ouverts, on tente quand même le meilleur (mieux vaut
 *    un essai qu'une erreur immédiate).
 *
 * 2. Les décisions sont EN MÉMOIRE (mono-processus serverless) : état
 *    léger, sans persistance — un cold start repart sur un état sain, ce
 *    qui est le comportement souhaité après un incident.
 *
 * Confidentialité : ne stocke JAMAIS le contenu des requêtes — uniquement
 * des compteurs et horodatages par fournisseur.
 */

import type { AIProvider } from "./models";

const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

type BreakerState = "closed" | "open" | "half-open";

interface BreakerEntry {
  state: BreakerState;
  consecutiveFailures: number;
  openedAtMs: number;
  cooldownMs: number;
  /** Un seul essai autorisé en half-open. */
  halfOpenProbeInFlight: boolean;
}

const breakers = new Map<AIProvider, BreakerEntry>();

function entry(provider: AIProvider): BreakerEntry {
  let current = breakers.get(provider);
  if (!current) {
    current = { state: "closed", consecutiveFailures: 0, openedAtMs: 0, cooldownMs: BASE_COOLDOWN_MS, halfOpenProbeInFlight: false };
    breakers.set(provider, current);
  }
  return current;
}

/** Le provider accepte-t-il une requête maintenant ? */
export function isProviderAvailable(provider: AIProvider, now = Date.now()): boolean {
  const current = entry(provider);
  if (current.state === "closed") return true;
  if (current.state === "open") {
    if (now - current.openedAtMs >= current.cooldownMs) {
      current.state = "half-open";
      current.halfOpenProbeInFlight = false;
    } else {
      return false;
    }
  }
  if (current.state === "half-open") {
    if (current.halfOpenProbeInFlight) return false;
    current.halfOpenProbeInFlight = true;
    return true;
  }
  return true;
}

export function recordProviderSuccess(provider: AIProvider): void {
  const current = entry(provider);
  current.state = "closed";
  current.consecutiveFailures = 0;
  current.cooldownMs = BASE_COOLDOWN_MS;
  current.halfOpenProbeInFlight = false;
}

export function recordProviderFailure(provider: AIProvider): void {
  const current = entry(provider);
  current.consecutiveFailures += 1;
  current.halfOpenProbeInFlight = false;
  if (current.state === "half-open" || current.consecutiveFailures >= FAILURE_THRESHOLD) {
    if (current.state !== "open") {
      current.state = "open";
      current.openedAtMs = Date.now();
      current.cooldownMs = Math.min(current.cooldownMs * 2, MAX_COOLDOWN_MS);
    }
  }
}

/** Nombre de fournisseurs ouverts (observabilité / health). */
export function openProviderCount(): number {
  let open = 0;
  for (const current of breakers.values()) {
    if (current.state === "open" || current.state === "half-open") open += 1;
  }
  return open;
}

/** Instantané de l'état d'un fournisseur (observabilité, health, tests). */
export function getBreakerSnapshot(provider: AIProvider): {
  state: BreakerState;
  consecutiveFailures: number;
  cooldownMs: number;
} | null {
  const current = breakers.get(provider);
  if (!current) return null;
  return {
    state: current.state,
    consecutiveFailures: current.consecutiveFailures,
    cooldownMs: current.cooldownMs,
  };
}

/** Réinitialisation (tests / administration). */
export function resetBreakers(): void {
  breakers.clear();
}

/**
 * Force l'écoulement du cooldown d'un fournisseur (tests et administration :
 * permet de sonder immédiatement un rétablissement sans attendre le délai).
 */
export function forceCooldownElapsed(provider: AIProvider): void {
  const current = breakers.get(provider);
  if (current?.state === "open") {
    current.openedAtMs = Date.now() - current.cooldownMs - 1;
  }
}
