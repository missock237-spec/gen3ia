import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pont OpenTelemetry (Task 59, priorité #3) :
 *   - DÉSACTIVÉ (sans OTEL_EXPORTER_OTLP_ENDPOINT) : toute la surface est
 *     un no-op sûr — aucune exception, aucune émission, SDK jamais importé
 *     (zéro impact cold-start) ;
 *   - ACTIVÉ : les métriques d'exécution portent la dimension organisation
 *     (orgId Task 58) et les événements deviennent des spans corrélées au
 *     traceId ; un événement « failed » est marqué ERROR.
 *
 * Task K (tracing distribué) :
 *   - échantillonnage ParentBased(TraceIdRatioBased) piloté par
 *     OTEL_TRACES_SAMPLER_ARG (défaut 0.1) — le module sdk-trace-base est
 *     mocké pour éprouver LE CABLAGE (dégradation gracieuse incluse) ;
 *   - spans HTTP serveur MANUELLES (demarrerSpanServeur) : no-op sans
 *     endpoint, SERVER + statut/ERROR avec endpoint ;
 *   - repli corrélation : traceId repris de l'AsyncLocalStorage quand les
 *     métadonnées d'exécution sont muettes.
 *
 * Le SDK (sdk-node + exporters) est mocké : ce sont les CONTRATS du pont
 * qui sont éprouvés (interrupteur, attributs, fire-and-forget), pas la
 * plateforme OTel elle-même.
 */

const mockedMeter = vi.hoisted(() => ({
  createCounter: vi.fn(),
  createHistogram: vi.fn(),
}));
const mockedTracer = vi.hoisted(() => ({
  startSpan: vi.fn(),
}));
const mockedMetrics = vi.hoisted(() => ({
  getMeter: vi.fn(() => mockedMeter),
}));
const mockedTrace = vi.hoisted(() => ({
  getTracer: vi.fn(() => mockedTracer),
}));
/** Configurations passées au constructeur NodeSDK (capture de câblage). */
const sdkConfigCapture = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@opentelemetry/api", () => ({
  metrics: mockedMetrics,
  trace: mockedTrace,
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
  SpanKind: { SERVER: 1 },
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn(function NodeSDKMock(config?: Record<string, unknown>) {
    sdkConfigCapture.push(config ?? {});
    return { start: vi.fn(), shutdown: vi.fn(async () => undefined) };
  }),
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({ OTLPTraceExporter: vi.fn() }));
vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({ OTLPMetricExporter: vi.fn() }));
vi.mock("@opentelemetry/sdk-metrics", () => ({ PeriodicExportingMetricReader: vi.fn() }));
vi.mock("@opentelemetry/resources", () => ({ resourceFromAttributes: vi.fn(() => ({})) }));
vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
}));

type OtelModule = typeof import("./otel");

async function loadModule(
  otlpEndpoint: string | undefined,
  premock?: () => void,
): Promise<OtelModule> {
  vi.resetModules();
  vi.clearAllMocks();
  sdkConfigCapture.length = 0;
  premock?.();
  if (otlpEndpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otlpEndpoint;
  else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return import("./otel");
}

function counterMock() {
  return { add: vi.fn() };
}
function histogramMock() {
  return { record: vi.fn() };
}
function spanMock() {
  return { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
}
/** Span complète pour demarrerSpanServeur (setAttribute SINGULIER utilisé). */
function spanServeurMock() {
  return { setAttribute: vi.fn(), setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
}

beforeEach(() => {
  // Par défaut : instruments valides quand le module initialise le pont.
  mockedMeter.createCounter.mockImplementation(() => counterMock());
  mockedMeter.createHistogram.mockImplementation(() => histogramMock());
  mockedTracer.startSpan.mockImplementation(() => spanMock());
});

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_TRACES_SAMPLER_ARG;
});

describe("pont OTel désactivé (aucun endpoint OTLP)", () => {
  it("isOtelExportEnabled est false et le SDK n'est JAMAIS démarré", async () => {
    const otel = await loadModule(undefined);
    expect(otel.isOtelExportEnabled()).toBe(false);
    await otel.initOtel();
    expect(otel.isOtelSdkStarted()).toBe(false);
    expect(mockedMetrics.getMeter).not.toHaveBeenCalled();
  });

  it("métriques et spans sont des no-op sans exception", async () => {
    const otel = await loadModule(undefined);
    expect(() => otel.recordExecutionMetrics({
      executionId: "exec-1", status: "completed", orgId: "org-1", chargeMinor: 120,
    })).not.toThrow();
    expect(() => otel.traceExecutionEvent({
      executionId: "exec-1", type: "tool.completed", metadata: { traceId: "trc_x" },
    })).not.toThrow();
    expect(mockedTracer.startSpan).not.toHaveBeenCalled();
  });
});

describe("pont OTel activé (OTEL_EXPORTER_OTLP_ENDPOINT défini)", () => {
  it("init démarre le SDK et crée les instruments une seule fois", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    expect(otel.isOtelSdkStarted()).toBe(true);
    expect(mockedMeter.createCounter).toHaveBeenCalledTimes(2);
    expect(mockedMeter.createHistogram).toHaveBeenCalledTimes(2);
    // Double init : idempotent (le SDK ne redémarre pas).
    await otel.initOtel();
    expect(mockedMeter.createCounter).toHaveBeenCalledTimes(2);
  });

  it("recordExecutionMetrics : compteur exécutions + tokens + coût avec orgId", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    const executions = mockedMeter.createCounter.mock.results[0].value;
    const tokens = mockedMeter.createCounter.mock.results[1].value;
    const [cost, duration] = mockedMeter.createHistogram.mock.results.map((r) => r.value);

    otel.recordExecutionMetrics({
      executionId: "exec-42",
      status: "completed",
      orgId: "org-1",
      userId: "u1",
      agentId: "agent-a",
      traceId: "trc_abc",
      chargeMinor: 350,
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 5_000,
    });

    expect(executions.add).toHaveBeenCalledWith(1, expect.objectContaining({
      "gen3ia.execution_id": "exec-42",
      "gen3ia.status": "completed",
      "gen3ia.org_id": "org-1",
      "gen3ia.user_id": "u1",
      "gen3ia.agent_id": "agent-a",
      "gen3ia.trace_id": "trc_abc",
    }));
    expect(tokens.add).toHaveBeenCalledWith(100, expect.objectContaining({ "gen3ia.direction": "input" }));
    expect(tokens.add).toHaveBeenCalledWith(200, expect.objectContaining({ "gen3ia.direction": "output" }));
    expect(cost.record).toHaveBeenCalledWith(350, expect.objectContaining({ "gen3ia.org_id": "org-1" }));
    expect(duration.record).toHaveBeenCalledWith(5_000, expect.anything());
  });

  it("valeurs nulles/absentes : aucune émission tokens/coût/durée", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    const tokens = mockedMeter.createCounter.mock.results[1].value;
    const [cost, duration] = mockedMeter.createHistogram.mock.results.map((r) => r.value);

    otel.recordExecutionMetrics({ executionId: "exec-0", status: "failed" });
    expect(tokens.add).not.toHaveBeenCalled();
    expect(cost.record).not.toHaveBeenCalled();
    expect(duration.record).not.toHaveBeenCalled();
  });

  it("traceExecutionEvent : span nommée, attributs de corrélation, ERROR sur failed", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    const span = spanMock();
    mockedTracer.startSpan.mockImplementation(() => span);

    otel.traceExecutionEvent({
      executionId: "exec-7",
      type: "tool.failed",
      toolName: "web.search",
      durationMs: 300,
      metadata: { traceId: "trc_z", orgId: "org-2" },
    });

    expect(mockedTracer.startSpan).toHaveBeenCalledWith("gen3ia.tool.failed");
    expect(span.setAttributes).toHaveBeenCalledWith(expect.objectContaining({
      "gen3ia.execution_id": "exec-7",
      "gen3ia.tool_name": "web.search",
      "gen3ia.trace_id": "trc_z",
      "gen3ia.org_id": "org-2",
    }));
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 }); // ERROR
    expect(span.end).toHaveBeenCalled();
  });

  it("panne du collecteur : recordExecutionMetrics ne lève JAMAIS", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    mockedMeter.createCounter.mock.results[0].value.add.mockImplementation(() => {
      throw new Error("collecteur indisponible");
    });
    expect(() => otel.recordExecutionMetrics({ executionId: "e", status: "completed" })).not.toThrow();
  });
});

describe("executionMetricAttrs (mapping pur)", () => {
  it("assainit : vides ignorés, longueurs bornées", async () => {
    const otel = await loadModule(undefined);
    const attrs = otel.executionMetricAttrs({
      executionId: "e".repeat(200),
      status: "completed",
      orgId: "  ",
      userId: "u".repeat(200),
    });
    expect(attrs["gen3ia.execution_id"]).toHaveLength(128);
    expect(attrs["gen3ia.org_id"]).toBeUndefined();
    expect(attrs["gen3ia.user_id"]).toHaveLength(128);
    expect(attrs["gen3ia.status"]).toBe("completed");
  });
});

/* ------------------------------------------------------------------ */
/* Task K — tracing distribué                                            */
/* ------------------------------------------------------------------ */

describe("tauxEchantillonnageTraces (Task K)", () => {
  it("défaut 0.1 sans OTEL_TRACES_SAMPLER_ARG", async () => {
    const otel = await loadModule(undefined);
    delete process.env.OTEL_TRACES_SAMPLER_ARG;
    expect(otel.tauxEchantillonnageTraces()).toBe(0.1);
  });

  it("parse borné [0, 1] : 0 légitime, > 1 plafonné, invalide/négatif → défaut", async () => {
    const otel = await loadModule(undefined);
    for (const [brut, attendu] of [
      ["0.5", 0.5],
      ["0.05", 0.05],
      ["1", 1],
      ["0", 0],
      ["2", 1],
      ["abc", 0.1],
      ["-1", 0.1],
      [" 0.25 ", 0.25],
    ] as const) {
      process.env.OTEL_TRACES_SAMPLER_ARG = brut;
      expect(otel.tauxEchantillonnageTraces()).toBe(attendu);
    }
  });
});

describe("échantillonnage des traces — câblage NodeSDK (Task K)", () => {
  it("sdk-trace-base disponible : NodeSDK reçoit ParentBased(TraceIdRatioBased(ARG))", async () => {
    const otel = await loadModule("http://collector:4318", () => {
      vi.doMock("@opentelemetry/sdk-trace-base", () => ({
        TraceIdRatioBasedSampler: vi.fn(function TraceIdRatioBasedSamplerMock(ratio: number) {
          return { ratio };
        }),
        ParentBasedSampler: vi.fn(function ParentBasedSamplerMock(options: { root?: unknown }) {
          return { root: options?.root };
        }),
      }));
    });
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.5";
    await otel.initOtel();
    expect(otel.isOtelSdkStarted()).toBe(true);
    const sampler = sdkConfigCapture[0]?.sampler as { root?: { ratio?: number } } | undefined;
    expect(sampler).toBeDefined();
    expect(sampler?.root?.ratio).toBe(0.5);
    expect(sdkConfigCapture[0]?.resource).toBeDefined();
    expect(sdkConfigCapture[0]?.traceExporter).toBeDefined();
  });

  it("sdk-trace-base INDISPONIBLE : init réussit sans sampler (dégradation gracieuse)", async () => {
    const otel = await loadModule("http://collector:4318", () => {
      vi.doMock("@opentelemetry/sdk-trace-base", () => {
        throw new Error("module indisponible (simulation)");
      });
    });
    await otel.initOtel();
    expect(otel.isOtelSdkStarted()).toBe(true);
    expect(sdkConfigCapture[0]?.sampler).toBeUndefined();
  });
});

describe("spans HTTP serveur manuelles (Task K)", () => {
  it("no-op sans endpoint : aucune span créée, end() silencieux", async () => {
    const otel = await loadModule(undefined);
    const span = otel.demarrerSpanServeur({ route: "/api/chat", methode: "POST", chemin: "/api/chat" });
    expect(() => span.end(200)).not.toThrow();
    expect(mockedTracer.startSpan).not.toHaveBeenCalled();
  });

  it("avec endpoint : span « http.server » SERVER, corrélée, statut 5xx → ERROR", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    const span = spanServeurMock();
    mockedTracer.startSpan.mockImplementation(() => span);

    const spanServeur = otel.demarrerSpanServeur({
      route: "/api/chat",
      methode: "post",
      chemin: "/api/chat",
      traceId: "trc_span-1",
    });
    expect(mockedTracer.startSpan).toHaveBeenCalledWith(
      "http.server",
      expect.objectContaining({
        kind: 1, // SpanKind.SERVER (mock api)
        attributes: expect.objectContaining({
          "http.request.method": "POST",
          "url.path": "/api/chat",
          "gen3ia.route": "/api/chat",
          "gen3ia.trace_id": "trc_span-1",
        }),
      }),
    );

    spanServeur.end(503);
    expect(span.setAttribute).toHaveBeenCalledWith("http.response.status_code", 503);
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 }); // ERROR
    expect(span.end).toHaveBeenCalled();
  });

  it("statut 2xx → OK ; panne du tracer → end() silencieux", async () => {
    const otel = await loadModule("http://collector:4318");
    await otel.initOtel();
    const span = spanServeurMock();
    mockedTracer.startSpan.mockImplementation(() => span);
    otel.demarrerSpanServeur({ route: "/api/health" }).end(200);
    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 }); // OK

    span.setAttribute.mockImplementation(() => {
      throw new Error("tracer en panne");
    });
    expect(() => otel.demarrerSpanServeur({ route: "/api/health" }).end(200)).not.toThrow();
  });
});

describe("repli corrélation AsyncLocalStorage (Task K)", () => {
  it("traceExecutionEvent sans metadata traceId → traceId du contexte courant", async () => {
    const otel = await loadModule("http://collector:4318");
    // Import APRÈS loadModule (même génération de modules que le pont OTel :
    // une seule instance d'AsyncLocalStorage partagée).
    const { executerAvecContexteRequete } = await import("./contexte-requete");
    await otel.initOtel();
    const span = spanMock();
    mockedTracer.startSpan.mockImplementation(() => span);

    executerAvecContexteRequete({ traceId: "trc_als-42" }, () => {
      otel.traceExecutionEvent({ executionId: "e-1", type: "step.completed", metadata: {} });
    });

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "gen3ia.trace_id": "trc_als-42" }),
    );
  });

  it("metadata explicite PRIORITAIRE sur l'AsyncLocalStorage", async () => {
    const otel = await loadModule("http://collector:4318");
    // Import APRÈS loadModule (même génération de modules que le pont OTel :
    // une seule instance d'AsyncLocalStorage partagée).
    const { executerAvecContexteRequete } = await import("./contexte-requete");
    await otel.initOtel();
    const span = spanMock();
    mockedTracer.startSpan.mockImplementation(() => span);

    executerAvecContexteRequete({ traceId: "trc_als" }, () => {
      otel.traceExecutionEvent({
        executionId: "e-2",
        type: "tool.completed",
        metadata: { traceId: "trc_explicite" },
      });
    });

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "gen3ia.trace_id": "trc_explicite" }),
    );
  });

  it("recordExecutionMetrics sans traceId → attribut enrichi depuis le contexte", async () => {
    const otel = await loadModule("http://collector:4318");
    // Import APRÈS loadModule (même génération de modules que le pont OTel :
    // une seule instance d'AsyncLocalStorage partagée).
    const { executerAvecContexteRequete } = await import("./contexte-requete");
    await otel.initOtel();
    const executions = mockedMeter.createCounter.mock.results[0].value;

    executerAvecContexteRequete({ traceId: "trc_als-metrics" }, () => {
      otel.recordExecutionMetrics({ executionId: "e-3", status: "completed" });
    });

    expect(executions.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "gen3ia.trace_id": "trc_als-metrics" }),
    );
  });
});
