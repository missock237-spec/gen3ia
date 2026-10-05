import "server-only";

import { metrics, trace, type Counter, type Histogram, type Meter, type Span, SpanStatusCode, type Tracer } from "@opentelemetry/api";

/**
 * Export OpenTelemetry (Task 59, priorité #3 — recommandations utilisateur).
 *
 * Objectif : exporter TRACES + MÉTRIQUES vers un collecteur OTLP
 * (Datadog, Grafana Cloud/Agent, Jaeger, …) SANS impact quand la fonction
 * n'est pas utilisée :
 *   - interrupteur UNIQUE = OTEL_EXPORTER_OTLP_ENDPOINT (convention OTel) ;
 *     sans cet env var, aucun import du SDK, aucune span, aucune émission
 *     (chemin no-op testé, coût ~un booléen) ;
 *   - le SDK (lourd) est importé DYNAMIQUEMENT par l'init et reste externe
 *     au bundle serveur (serverExternalPackages) ;
 *   - corrélation primaire = traceId Gen3ia existant (attribut
 *     `gen3ia.trace_id` + spanLinks potentiels côté collecteur) ;
 *   - dimension organisation = orgId (Task 58) sur TOUTES les métriques
 *     d'exécution : facturation fine par organisation, quotas, adoption.
 *
 * Sécurité : seules des données TECHNIQUES quittent la plateforme — ids
 * (exécution, agent, org, user, trace), noms d'outils/modèles, compteurs
 * de tokens, coûts agrégés. AUCUN contenu de conversation, prompt, sortie
 * ou donnée personnelle (cohérent avec la politique Sentry du projet).
 *
 * Résilience : toute la surface est fire-and-forget — un incident
 * d'export (collecteur indisponible, réseau) ne doit JAMAIS casser une
 * exécution métier ni lever dans une route.
 */

/** Interrupteur principal : endpoint OTLP défini = export activé. */
export function isOtelExportEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

/** Nom d'attribut Gen3ia (préfixe dédié — pas de collision sémantique). */
export const ATTR_EXECUTION_ID = "gen3ia.execution_id";
export const ATTR_TRACE_ID = "gen3ia.trace_id";
export const ATTR_ORG_ID = "gen3ia.org_id";
export const ATTR_USER_ID = "gen3ia.user_id";
export const ATTR_AGENT_ID = "gen3ia.agent_id";
export const ATTR_STATUS = "gen3ia.status";
export const ATTR_CHARGE_MINOR = "gen3ia.charge_minor";
export const ATTR_PROVIDER_COST_EUR = "gen3ia.provider_cost_eur";

/** Attributs de métrique d'exécution — orgId/userId assainis (jamais vides). */
export function executionMetricAttrs(input: {
  executionId: string;
  orgId?: string;
  userId?: string;
  agentId?: string;
  traceId?: string;
  status: string;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    [ATTR_EXECUTION_ID]: input.executionId.slice(0, 128),
    [ATTR_STATUS]: input.status.slice(0, 32),
  };
  const orgId = input.orgId?.trim();
  if (orgId) attrs[ATTR_ORG_ID] = orgId.slice(0, 128);
  const userId = input.userId?.trim();
  if (userId) attrs[ATTR_USER_ID] = userId.slice(0, 128);
  const agentId = input.agentId?.trim();
  if (agentId) attrs[ATTR_AGENT_ID] = agentId.slice(0, 128);
  const traceId = input.traceId?.trim();
  if (traceId) attrs[ATTR_TRACE_ID] = traceId.slice(0, 64);
  return attrs;
}

/* ------------------------------------------------------------------ */
/* Instruments (créés UNE fois, APRÈS le démarrage effectif du SDK)   */
/* ------------------------------------------------------------------ */

interface OtelInstruments {
  meter: Meter;
  tracer: Tracer;
  executionsTotal: Counter;
  tokensTotal: Counter;
  costMinor: Histogram;
  durationMs: Histogram;
}

let instruments: OtelInstruments | null = null;
let sdkStarted = false;

/** Drapeau interne (tests) : SDK démarré. */
export function isOtelSdkStarted(): boolean {
  return sdkStarted;
}

/**
 * Init du SDK — appelé UNIQUEMENT par instrumentation.ts quand l'endpoint
 * est défini (runtime nodejs). Import dynamique du SDK lourd : jamais
 * chargé quand l'export est désactivé. Un échec d'init est journalisé et
 * neutre pour l'application.
 */
export async function initOtel(): Promise<void> {
  if (!isOtelExportEnabled() || sdkStarted) return;
  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { OTLPMetricExporter }, { PeriodicExportingMetricReader }, { resourceFromAttributes }, semconv] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

    const environment = process.env.NODE_ENV ?? "development";
    const commit = process.env.VERCEL_GIT_COMMIT_SHA?.trim() || process.env.SENTRY_RELEASE?.trim() || undefined;

    const resource = resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: "gen3ia-ai-studio",
      [semconv.ATTR_SERVICE_VERSION]: commit ?? "unknown",
      ["deployment.environment"]: environment,
    });

    const sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter(),
      // Poussée métrique 30 s : fenêtre compatible serverless (une fonction
      // vit rarement 60 s entières — la prochaine instance repousse le solde).
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 30_000,
      }),
    });
    sdk.start();
    sdkStarted = true;

    // Instruments créés après start() : le MeterProvider global est alors
    // le SDK (sinon ce serait le no-op de l'API).
    const meter = metrics.getMeter("gen3ia-ai-studio", "1.0.0");
    instruments = {
      meter,
      tracer: trace.getTracer("gen3ia-ai-studio", "1.0.0"),
      executionsTotal: meter.createCounter("gen3ia.executions.total", { description: "Nombre d'exécutions d'agents par organisation et statut" }),
      tokensTotal: meter.createCounter("gen3ia.tokens.total", { description: "Tokens LLM consommés (input + output) par organisation" }),
      costMinor: meter.createHistogram("gen3ia.execution.cost_minor", { description: "Coût facturé par exécution (unités mineures XAF)", unit: "minor" }),
      durationMs: meter.createHistogram("gen3ia.execution.duration_ms", { description: "Durée totale d'exécution", unit: "ms" }),
    };

    // Flush best-effort à l'arrêt (SIGTERM serverless / rotate) — jamais bloquant.
    const shutdown = () => {
      void sdk.shutdown().catch(() => undefined);
    };
    process.once("SIGTERM", shutdown);
    process.once("beforeExit", shutdown);
  } catch (error) {
    // L'observabilité ne doit JAMAIS empêcher l'application de démarrer.
    console.error("[otel] init ignorée (export désactivé ou SDK indisponible):", error instanceof Error ? error.message : error);
  }
}

/* ------------------------------------------------------------------ */
/* Métriques d'exécution (coût par organisation)                      */
/* ------------------------------------------------------------------ */

export interface ExecutionTelemetry {
  executionId: string;
  status: string;
  orgId?: string;
  userId?: string;
  agentId?: string;
  traceId?: string;
  chargeMinor?: number;
  providerCostEur?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

/**
 * Enregistre une exécution terminée dans les métriques OTel (dimension
 * organisation). No-op garanti quand l'export est désactivé ou que le SDK
 * n'a pas démarré — jamais d'exception propagée.
 */
export function recordExecutionMetrics(telemetry: ExecutionTelemetry): void {
  try {
    if (!sdkStarted || !instruments) return;
    const attrs = executionMetricAttrs(telemetry);
    instruments.executionsTotal.add(1, attrs);
    const inputTokens = telemetry.inputTokens ?? 0;
    const outputTokens = telemetry.outputTokens ?? 0;
    if (inputTokens > 0) instruments.tokensTotal.add(inputTokens, { ...attrs, ["gen3ia.direction"]: "input" });
    if (outputTokens > 0) instruments.tokensTotal.add(outputTokens, { ...attrs, ["gen3ia.direction"]: "output" });
    if ((telemetry.chargeMinor ?? 0) > 0) instruments.costMinor.record(telemetry.chargeMinor!, attrs);
    if (telemetry.durationMs !== undefined && telemetry.durationMs > 0) instruments.durationMs.record(telemetry.durationMs, attrs);
  } catch {
    /* fire-and-forget : aucune télémétrie ne casse une route. */
  }
}

/* ------------------------------------------------------------------ */
/* Pont événements d'exécution → spans                                */
/* ------------------------------------------------------------------ */

export interface TraceableExecutionEvent {
  executionId: string;
  type: string;
  agentId?: string;
  stepId?: string;
  toolName?: string;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  metadata: Record<string, unknown>;
}

/** Lit une valeur texte sûre du metadata (corrélation traceId/orgId). */
function metaText(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Transforme un événement d'exécution en span OTel (créée et fermée
 * immédiatement — pattern « event-as-span » : la reconstruction de la
 * timeline par le collecteur s'appuie sur gen3ia.execution_id +
 * gen3ia.trace_id). No-op quand désactivé ; jamais d'exception.
 */
export function traceExecutionEvent(event: TraceableExecutionEvent): void {
  try {
    if (!sdkStarted || !instruments) return;
    const span: Span = instruments.tracer.startSpan(`gen3ia.${event.type}`);
    const attributes: Record<string, string | number | undefined> = {
      [ATTR_EXECUTION_ID]: event.executionId,
      [ATTR_STATUS]: event.type,
      "gen3ia.step_id": event.stepId,
      "gen3ia.tool_name": event.toolName,
      "gen3ia.model": event.model,
      "gen3ia.duration_ms": event.durationMs,
      "gen3ia.input_tokens": event.inputTokens,
      "gen3ia.output_tokens": event.outputTokens,
    };
    const traceId = metaText(event.metadata, "traceId");
    const orgId = metaText(event.metadata, "orgId");
    const userId = metaText(event.metadata, "userId");
    if (traceId) attributes[ATTR_TRACE_ID] = traceId;
    if (orgId) attributes[ATTR_ORG_ID] = orgId;
    if (userId) attributes[ATTR_USER_ID] = userId;
    const agentId = event.agentId;
    if (agentId) attributes[ATTR_AGENT_ID] = agentId;
    span.setAttributes(attributes);
    if (event.type.endsWith(".failed")) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  } catch {
    /* fire-and-forget. */
  }
}
