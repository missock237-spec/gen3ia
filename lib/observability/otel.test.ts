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

vi.mock("@opentelemetry/api", () => ({
  metrics: mockedMetrics,
  trace: mockedTrace,
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn(function NodeSDKMock() {
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

async function loadModule(otlpEndpoint: string | undefined): Promise<OtelModule> {
  vi.resetModules();
  vi.clearAllMocks();
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

beforeEach(() => {
  // Par défaut : instruments valides quand le module initialise le pont.
  mockedMeter.createCounter.mockImplementation(() => counterMock());
  mockedMeter.createHistogram.mockImplementation(() => histogramMock());
  mockedTracer.startSpan.mockImplementation(() => spanMock());
});

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
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
