import { metrics } from "@opentelemetry/api";

import { logger } from "@/lib/observability/logger";

/**
 * MÉTRIQUES CUSTOM GEN3IA (intentions du commit f7261a3, intégrées à
 * l'observabilité RÉELLE du projet).
 *
 * Correctif d'intégration (Task 127) : le module d'origine importait
 * `Metrics` (inexistant — l'API OTel exporte `metrics`) et référençait des
 * collecteurs hallucinés. Ici : compteur/histogrammes OTel standard,
 * fonctionnement dégradé propre quand l'export OTel n'est pas configuré
 * (les instruments existent toujours — ils n'émettent simplement rien).
 *
 * Le registre OFFICIEL des métriques d'exécutions reste lib/observability/
 * otel.ts (gen3ia.executions.total, gen3ia.tokens.total…) — ce module couvre
 * les métriques produit complémentaires (agents, erreurs, latence API).
 */

const meter = metrics.getMeter("gen3ia-product", "1.0.0");

export class Gen3iaMetrics {
  static agentExecutions = meter.createCounter("gen3ia.agents.executions_total", {
    description: "Total d'exécutions d'agents par identifiant et statut",
  });

  static apiLatency = meter.createHistogram("gen3ia.api.latency_ms", {
    description: "Latence des réponses API (millisecondes)",
    unit: "ms",
  });

  static tokenUsage = meter.createHistogram("gen3ia.llm.tokens", {
    description: "Tokens LLM consommés par requête (prompt + complétion)",
    unit: "tokens",
  });

  static errorRate = meter.createCounter("gen3ia.errors.total", {
    description: "Total d'erreurs par type",
  });

  /** Enregistre une exécution d'agent (compteur + latence). */
  static recordExecution(agentId: string, durationMs: number, success: boolean): void {
    this.agentExecutions.add(1, { agent_id: agentId, success: String(success) });
    this.apiLatency.record(durationMs, { agent_id: agentId });
  }

  /** Enregistre l'usage de tokens d'une requête LLM. */
  static recordTokens(agentId: string, promptTokens: number, completionTokens: number): void {
    this.tokenUsage.record(promptTokens + completionTokens, { agent_id: agentId });
  }

  /** Enregistre une erreur typée. */
  static recordError(type: string): void {
    this.errorRate.add(1, { error_type: type });
  }
}

/** Santé système — primitives RÉELLES locales (sans dépendance externe). */
export function getSystemHealth(): {
  status: "healthy" | "degraded";
  uptimeSec: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  checkedAt: string;
} {
  const memory = process.memoryUsage();
  const heapUsedRatio = memory.heapUsed / Math.max(1, memory.heapTotal);
  return {
    status: heapUsedRatio > 0.9 ? "degraded" : "healthy",
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    checkedAt: new Date().toISOString(),
  };
}

/** Trace structurée de santé (pour le logger pino — sans stack d'alerte). */
export function logSystemHealth(): void {
  const health = getSystemHealth();
  logger.info({ health, service: "gen3ia-ai-studio" }, "system_health_checked");
}
