import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/* Surface « config only » du Training Studio (demande utilisateur 6).  */
/*  - les endpoints de mécanique interne brute (sweep/dispatch          */
/*    orchestrateur, rafraîchissement fournisseur, lanceur d'arène)     */
/*    répondent 403 JSON clair à un utilisateur standard, 401 sans      */
/*    session, et restent accessibles à l'opérateur admin ;             */
/*  - l'utilisateur standard CONSERVE ses flux de configuration et le   */
/*    contrôle de ses propres tâches (annulation).                      */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security/admin-access", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/training/repository", () => ({
  getProject: vi.fn(),
  listJobs: vi.fn(),
  listSessionsArene: vi.fn(),
  getModel: vi.fn(),
  saveSessionArene: vi.fn(),
  getJob: vi.fn(),
  saveJob: vi.fn(),
  createProject: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock("@/lib/training/orchestrator", () => ({
  sweepUserJobs: vi.fn(),
  refreshJob: vi.fn(),
  cancelJob: vi.fn(),
  createJobFromPlan: vi.fn(),
}));
vi.mock("@/lib/training/arene-orchestrator", () => ({ lancerSessionArene: vi.fn() }));
vi.mock("@/lib/training/quotas", () => ({
  assertCanCreateProject: vi.fn(),
  assertAssetQuota: vi.fn(),
  assertUploadSize: vi.fn(),
  assertJobConcurrency: vi.fn(),
}));
vi.mock("@/lib/training/audit", () => ({
  ipFromRequest: vi.fn(() => "127.0.0.1"),
  recordTrainingAudit: vi.fn(() => Promise.resolve()),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { requireAdmin } from "@/lib/security/admin-access";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { HttpError, unauthorized } from "@/lib/security/http-errors";
import * as repository from "@/lib/training/repository";
import { cancelJob, refreshJob, sweepUserJobs } from "@/lib/training/orchestrator";
import { lancerSessionArene } from "@/lib/training/arene-orchestrator";

import { GET as listProjectJobsGET } from "@/app/api/training/projects/[id]/jobs/route";
import { GET as jobDetailGET } from "@/app/api/training/jobs/[jobId]/route";
import { GET as areneListGET, POST as areneLaunchPOST } from "@/app/api/training/projects/[id]/arene/route";
import { POST as cancelJobPOST } from "@/app/api/training/jobs/[jobId]/cancel/route";
import { POST as createProjectPOST } from "@/app/api/training/projects/route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedRequireAdmin = vi.mocked(requireAdmin);
const mockedRateLimit = vi.mocked(enforceRateLimit);
const mockedGetProject = vi.mocked(repository.getProject);
const mockedListJobs = vi.mocked(repository.listJobs);
const mockedGetJob = vi.mocked(repository.getJob);
const mockedGetModel = vi.mocked(repository.getModel);
const mockedCancelJob = vi.mocked(cancelJob);
const mockedRefreshJob = vi.mocked(refreshJob);
const mockedSweep = vi.mocked(sweepUserJobs);
const mockedLancerArene = vi.mocked(lancerSessionArene);
const mockedCreateProject = vi.mocked(repository.createProject);

const NOW = new Date().toISOString();

const project = {
  v: 1 as const,
  id: "p1",
  ownerId: "user-1",
  name: "Projet test",
  description: "",
  family: "text" as const,
  objective: "",
  primaryLanguage: "fr",
  dataTypes: [],
  mode: "assisted" as const,
  status: "active" as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const job = {
  v: 1 as const,
  id: "j1",
  projectId: "p1",
  planId: "pl1",
  ownerId: "user-1",
  status: "queued" as const,
  progressPercent: null,
  epochsTotal: null,
  epochsDone: null,
  currentStep: null,
  trainLoss: null,
  metrics: {},
  events: [],
  artifacts: [],
  simulated: false,
  waitingReason: null,
  providerId: null,
  externalJobId: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const sessionArene = {
  v: 1 as const,
  id: "s1",
  projectId: "p1",
  ownerId: "admin-1",
  mode: "eleve-contre-gen3" as const,
  professeurLabel: "Gen3",
  eleveLabel: "élève",
  statut: "terminee" as const,
  rounds: [],
  metriques: {
    roundsJoues: 0,
    renforcees: 0,
    distillees: 0,
    ignorees: 0,
    rewardMoyen: 0,
    progression: 0,
    rappelAvant: 0,
    rappelApres: 0,
  },
  etatEleveStorageKey: null,
  etatEleveTailleOctets: 0,
  error: null,
  dureeMs: 0,
  timebox: { budgetMs: 1000, arreteParTimebox: false },
  createdAt: NOW,
};

function getRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function postRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Utilisateur standard authentifié par défaut.
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  // Utilisateur standard : requireAdmin refuse (claims.admin absent).
  mockedRequireAdmin.mockRejectedValue(new HttpError(403, "Administrator access required.", "FORBIDDEN"));
  mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 2, retryAfterMs: 60_000 } as never);
});

describe("GET /api/training/projects/[id]/jobs (sweep orchestrateur)", () => {
  it("répond 403 JSON clair à un utilisateur standard et ne déclenche aucun sweep", async () => {
    const response = await listProjectJobsGET(getRequest("https://gen3ia.local/api/training/projects/p1/jobs"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error?: string; code?: string };
    expect(data.code).toBe("FORBIDDEN");
    expect(data.error).toContain("système");
    expect(data.error).toContain("studio");
    expect(mockedSweep).not.toHaveBeenCalled();
    expect(mockedListJobs).not.toHaveBeenCalled();
  });

  it("exige une authentification (401)", async () => {
    mockedRequireAdmin.mockRejectedValue(unauthorized());
    const response = await listProjectJobsGET(getRequest("https://gen3ia.local/api/training/projects/p1/jobs"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(response.status).toBe(401);
  });

  it("reste accessible à l'opérateur admin (diagnostic plateforme)", async () => {
    mockedRequireAdmin.mockResolvedValue({ uid: "admin-1", claims: { admin: true } } as never);
    mockedGetProject.mockResolvedValue(project);
    mockedSweep.mockResolvedValue({ dispatched: 0, refreshed: 0 });
    mockedListJobs.mockResolvedValue([]);
    const response = await listProjectJobsGET(getRequest("https://gen3ia.local/api/training/projects/p1/jobs"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { jobs: unknown[] };
    expect(data.jobs).toEqual([]);
  });
});

describe("GET /api/training/jobs/[jobId] (détail + rafraîchissement fournisseur)", () => {
  it("répond 403 JSON clair à un utilisateur standard sans rafraîchir la tâche", async () => {
    const response = await jobDetailGET(
      getRequest("https://gen3ia.local/api/training/jobs/j1?projectId=p1"),
      { params: Promise.resolve({ jobId: "j1" }) },
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error?: string; code?: string };
    expect(data.code).toBe("FORBIDDEN");
    expect(data.error).toContain("système");
    expect(mockedRefreshJob).not.toHaveBeenCalled();
  });

  it("reste accessible à l'opérateur admin (200)", async () => {
    mockedRequireAdmin.mockResolvedValue({ uid: "admin-1", claims: { admin: true } } as never);
    mockedGetProject.mockResolvedValue(project);
    mockedGetJob.mockResolvedValue(job);
    const response = await jobDetailGET(
      getRequest("https://gen3ia.local/api/training/jobs/j1?projectId=p1"),
      { params: Promise.resolve({ jobId: "j1" }) },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { job: { id: string } };
    expect(data.job.id).toBe("j1");
  });
});

describe("POST/GET /api/training/projects/[id]/arene (lanceur direct de calcul)", () => {
  it("POST répond 403 JSON clair à un utilisateur standard et ne lance aucune session", async () => {
    const response = await areneLaunchPOST(
      postRequest("https://gen3ia.local/api/training/projects/p1/arene", { mode: "eleve-contre-gen3", eleveAssetId: "m1" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error?: string; code?: string };
    expect(data.code).toBe("FORBIDDEN");
    expect(data.error).toContain("système");
    expect(mockedLancerArene).not.toHaveBeenCalled();
  });

  it("GET répond 403 à un utilisateur standard", async () => {
    const response = await areneListGET(getRequest("https://gen3ia.local/api/training/projects/p1/arene"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(response.status).toBe(403);
  });

  it("reste accessible à l'opérateur admin (201)", async () => {
    mockedRequireAdmin.mockResolvedValue({ uid: "admin-1", claims: { admin: true } } as never);
    mockedGetProject.mockResolvedValue(project);
    mockedGetModel.mockResolvedValue({ id: "m1", name: "élève", storageKey: null });
    mockedLancerArene.mockResolvedValue(sessionArene as never);
    const response = await areneLaunchPOST(
      postRequest("https://gen3ia.local/api/training/projects/p1/arene", { mode: "eleve-contre-gen3", eleveAssetId: "m1" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(response.status).toBe(201);
    const data = (await response.json()) as { session: { id: string } };
    expect(data.session.id).toBe("s1");
  });
});

describe("les flux utilisateur restent verts (config only)", () => {
  it("l'utilisateur standard crée son projet (configuration)", async () => {
    mockedCreateProject.mockResolvedValue(project);
    const response = await createProjectPOST(
      postRequest("https://gen3ia.local/api/training/projects", { name: "Projet test", family: "text", mode: "assisted" }),
    );
    expect(response.status).toBe(201);
    expect(mockedCreateProject).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ name: "Projet test", family: "text", mode: "assisted" }),
    );
  });

  it("l'utilisateur standard conserve l'annulation de SES tâches (contrôle nominal)", async () => {
    mockedGetProject.mockResolvedValue(project);
    mockedCancelJob.mockResolvedValue({ ...job, status: "cancelled" as const, finishedAt: NOW, updatedAt: NOW });
    const response = await cancelJobPOST(
      postRequest("https://gen3ia.local/api/training/jobs/j1/cancel", { projectId: "p1" }),
      { params: Promise.resolve({ jobId: "j1" }) },
    );
    expect(response.status).toBe(200);
    expect(mockedCancelJob).toHaveBeenCalledWith("user-1", "p1", "j1");
  });
});
