import "server-only";

import type {
  GpuProvider,
  GpuProviderCapabilities,
  ProviderJobState,
  SubmitJobPayload,
} from "./types";

/* ------------------------------------------------------------------ */
/* Fournisseur worker HTTP distant                                      */
/*                                                                    */
/* Un service Python séparé (FastAPI + PyTorch/PEFT) exposé par         */
/* TRAINING_WORKER_URL et protégé par TRAINING_WORKER_TOKEN.            */
/* Le worker N'EST PAS déployé par défaut : sans URL configurée, ce     */
/* fournisseur se déclare INDISPONIBLE — aucune simulation.             */
/* ------------------------------------------------------------------ */

const TIMEOUT_MS = 5_000;

function workerConfig(): { url: string; token: string } | null {
  const url = (process.env.TRAINING_WORKER_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return null;
  const token = (process.env.TRAINING_WORKER_TOKEN ?? "").trim();
  return { url, token };
}

async function workerFetch(
  cfg: { url: string; token: string },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

export const workerHttpProvider: GpuProvider = {
  id: "worker-http",
  label: "Worker GPU distant",

  async capabilities(): Promise<GpuProviderCapabilities> {
    const cfg = workerConfig();
    const unavailable: GpuProviderCapabilities = {
      providerId: "worker-http",
      label: "Worker GPU distant",
      gpus: [],
      maxDurationMinutes: null,
      simulated: false,
    };
    if (!cfg) return unavailable;
    try {
      const response = await workerFetch(cfg, "/capabilities");
      if (!response.ok) return unavailable;
      const body = (await response.json()) as {
        gpus?: Array<{ name?: string; vramGb?: number; available?: boolean }>;
        maxDurationMinutes?: number;
      };
      const gpus = Array.isArray(body.gpus)
        ? body.gpus
            .filter((g) => typeof g?.name === "string" && typeof g?.vramGb === "number")
            .map((g) => ({ name: String(g.name), vramGb: Number(g.vramGb), available: g.available !== false }))
        : [];
      return { ...unavailable, gpus, maxDurationMinutes: body.maxDurationMinutes ?? null };
    } catch {
      // Worker injoignable : HONNÊTE — aucune capacité déclarée.
      return unavailable;
    }
  },

  async submit(payload: SubmitJobPayload): Promise<{ externalId: string }> {
    const cfg = workerConfig();
    if (!cfg) throw new Error("Aucun worker GPU configuré (TRAINING_WORKER_URL absent).");
    const response = await workerFetch(cfg, "/jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Soumission refusée par le worker GPU (${response.status}) ${detail.slice(0, 200)}`);
    }
    const body = (await response.json()) as { jobId?: string; externalId?: string };
    const externalId = body.externalId ?? body.jobId;
    if (!externalId) throw new Error("Réponse du worker sans identifiant de tâche.");
    return { externalId };
  },

  async status(externalId: string): Promise<ProviderJobState> {
    const cfg = workerConfig();
    if (!cfg) throw new Error("Aucun worker GPU configuré (TRAINING_WORKER_URL absent).");
    const response = await workerFetch(cfg, `/jobs/${encodeURIComponent(externalId)}`);
    if (!response.ok) throw new Error(`État indisponible depuis le worker (${response.status}).`);
    const body = (await response.json()) as Partial<ProviderJobState> & { status?: string };
    const status = body.status === "completed" || body.status === "failed" ? body.status : "running";
    return {
      externalId,
      status,
      progressPercent: body.progressPercent ?? null,
      currentStep: body.currentStep ?? null,
      epochsDone: body.epochsDone ?? null,
      epochsTotal: body.epochsTotal ?? null,
      trainLoss: body.trainLoss ?? null,
      metrics: body.metrics ?? {},
      logs: Array.isArray(body.logs) ? body.logs.slice(-50) : [],
      error: body.error ?? null,
      artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
    };
  },

  async cancel(externalId: string): Promise<void> {
    const cfg = workerConfig();
    if (!cfg) throw new Error("Aucun worker GPU configuré (TRAINING_WORKER_URL absent).");
    const response = await workerFetch(cfg, `/jobs/${encodeURIComponent(externalId)}/cancel`, { method: "POST" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Annulation refusée par le worker (${response.status}).`);
    }
  },
};
