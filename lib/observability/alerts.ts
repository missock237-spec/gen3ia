import "server-only";

import { logger } from "@/lib/observability/logger";
import { captureServerMessage } from "@/lib/observability/sentry";
import { getSystemHealth } from "@/lib/observability/metrics";

/**
 * ALERTES DE PRODUCTION (intentions du commit 9534af7, intégrées à
 * l'observabilité RÉELLE du projet).
 *
 * Correctif d'intégration (Task 127) : le module d'origine importait un
 * `./alert-manager` inexistant et des canaux Slack/SMS non configurés.
 * Ici : moteur de règles typé sur les métriques RÉELLES disponibles
 * (santé process + seuils mémoire), canaux = logger pino + Sentry
 * (déjà câblés en production), anti-spam par cooldown en mémoire.
 */

/** Métriques évaluées par les règles d'alerte. */
export interface AlertMetrics {
  /** Taux d'erreurs observé (0..1). */
  errorRate: number;
  /** Latence P95 en millisecondes. */
  p95LatencyMs: number;
  /** Taux d'échec des agents (0..1). */
  agentFailureRate: number;
  /** Rapport usage/limite de tokens du jour (0..1). */
  tokenUsageRatio: number;
  /** Rapport heap utilisé/total (0..1). */
  heapUsedRatio: number;
}

export type AlertSeverity = "warning" | "critical";

export interface AlertRule {
  name: string;
  condition: (metrics: AlertMetrics) => boolean;
  severity: AlertSeverity;
  message: string;
  /** Anti-spam : secondes minimales entre deux déclenchements. */
  cooldownSec: number;
}

/** Règles par défaut (intentions d'origine, seuils conservés). */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    name: "High Error Rate",
    condition: (m) => m.errorRate > 0.05,
    severity: "critical",
    message: "Taux d'erreurs > 5 % sur la fenêtre observée",
    cooldownSec: 300,
  },
  {
    name: "High Latency",
    condition: (m) => m.p95LatencyMs > 3000,
    severity: "warning",
    message: "Latence P95 > 3 secondes",
    cooldownSec: 300,
  },
  {
    name: "Token Budget Alert",
    condition: (m) => m.tokenUsageRatio > 0.8,
    severity: "warning",
    message: "Approche de la limite de budget tokens du jour (≥ 80 %)",
    cooldownSec: 900,
  },
  {
    name: "Agent Failure Spike",
    condition: (m) => m.agentFailureRate > 0.1,
    severity: "critical",
    message: "Taux d'échec des agents > 10 %",
    cooldownSec: 300,
  },
  {
    name: "Memory Pressure",
    condition: (m) => m.heapUsedRatio > 0.9,
    severity: "warning",
    message: "Heap Node > 90 % de sa capacité",
    cooldownSec: 600,
  },
] as const;

/** Dernier déclenchement par règle (anti-spam en mémoire d'instance). */
const lastFired = new Map<string, number>();

function fireAlert(rule: AlertRule, metrics: AlertMetrics): void {
  const payload = {
    rule: rule.name,
    severity: rule.severity,
    message: rule.message,
    metrics: { errorRate: metrics.errorRate, p95LatencyMs: metrics.p95LatencyMs },
  };
  if (rule.severity === "critical") {
    logger.error(payload, "production_alert");
    captureServerMessage(`[ALERT] ${rule.name}: ${rule.message}`, "warning");
  } else {
    logger.warn(payload, "production_alert");
  }
}

/**
 * Évalue les règles contre des métriques fournies par l'appelant
 * (le centre de métriques du projet alimente AlertMetrics).
 */
export async function checkAndAlert(
  metrics: AlertMetrics,
  rules: readonly AlertRule[] = DEFAULT_ALERT_RULES,
): Promise<string[]> {
  const fired: string[] = [];
  const now = Date.now();
  for (const rule of rules) {
    if (!rule.condition(metrics)) continue;
    const last = lastFired.get(rule.name) ?? 0;
    if (now - last < rule.cooldownSec * 1000) continue;
    lastFired.set(rule.name, now);
    fireAlert(rule, metrics);
    fired.push(rule.name);
  }
  return fired;
}

/**
 * Contrôle automatique sur la santé système LOCALE (mémoire/uptime) —
 * utilisable depuis un cron ou une route de monitoring.
 */
export async function checkSystemAndAlert(): Promise<string[]> {
  const health = getSystemHealth();
  return checkAndAlert({
    errorRate: 0,
    p95LatencyMs: 0,
    agentFailureRate: 0,
    tokenUsageRatio: 0,
    heapUsedRatio: health.memory.heapUsedMb / Math.max(1, health.memory.heapTotalMb),
  });
}
