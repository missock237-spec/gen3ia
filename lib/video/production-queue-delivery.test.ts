import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Task 107-a — LIVRAISON CHAT des productions vidéo (production-queue).
 *
 * Objectif métier : « une fois la tâche lancée, elle finit complètement le
 * travail puis monte le résultat à l'utilisateur DANS le chat IA ». Les
 * tests verrouillent :
 *  - le portage de conversationId (création du job : persisté / omis) ;
 *  - la livraison automatique à la transition terminale (advanceProductionJob) :
 *    message assistant avec URL master + atelier, marqueur chatDeliveredAt ;
 *  - l'IDEMPOTENCE (second tick sur job terminal → PAS de second message) ;
 *  - le job SANS conversationId (aucune livraison, aucun crash) ;
 *  - la reprise après échec d'appendMessage (marqueur effacé, tick non-failing) ;
 *  - le contenu FR des messages (pure buildVideoDeliveryMessage).
 *
 * Patterns : mocks Firestore + couche résiliente repris de
 * production-queue-resume.test.ts — MAIS saveJobDoc/createJobDoc sont
 * PERSISTANTS (appliqués à firestoreState) pour que le marqueur
 * chatDeliveredAt écrit par deliverJobToConversation soit réellement relu
 * au claim du tick suivant (idempotence testée de bout en bout).
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice (docs + erreur tx)
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  txError: null as unknown,
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
        const path = `${name}/${id}`;
        return {
          __path: path,
          get: async () => {
            const data = firestoreState.docs.get(path);
            return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
          },
          set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
            const existing = firestoreState.docs.get(path);
            firestoreState.docs.set(path, opts?.merge === true ? { ...(existing ?? {}), ...payload } : { ...payload });
            return {};
          },
          create: async (payload: Record<string, unknown>) => {
            firestoreState.docs.set(path, { ...payload });
            return {};
          },
        };
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (firestoreState.txError) throw firestoreState.txError;
      return fn({
        get: async (ref: { __path: string }) => {
          const data = firestoreState.docs.get(ref.__path);
          return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
        },
        update: (ref: { __path: string }, patch: Record<string, unknown>) => {
          const existing = firestoreState.docs.get(ref.__path);
          firestoreState.docs.set(ref.__path, { ...(existing ?? {}), ...patch });
        },
      });
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock PARTIEL de queue-resume : loadJobDoc/saveJobDoc/createJobDoc/
// queryJobDocs PERSISTANTS sur firestoreState (le marqueur chatDeliveredAt
// doit survivre entre deux ticks pour tester l'idempotence réelle).
// ---------------------------------------------------------------------------

vi.mock("@/lib/video/queue-resume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/video/queue-resume")>();
  return {
    ...actual,
    loadJobDoc: vi.fn(),
    saveJobDoc: vi.fn(),
    createJobDoc: vi.fn(),
    queryJobDocs: vi.fn(),
  };
});

vi.mock("@/lib/db/firestore-resilient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/firestore-resilient")>();
  return {
    ...actual,
    writeCheckpointSet: (...args: Parameters<typeof import("@/lib/video/queue-resume")["saveJobDoc"]>) =>
      (queueResume.saveJobDoc as unknown as (...a: unknown[]) => Promise<void>)(...args),
    firestoreUsable: actual.firestoreUsable,
  };
});

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/video/project-service", () => ({
  createProject: vi.fn(async () => ({ id: "proj-1" })),
  getOwnedProjectOrThrow: vi.fn(),
  patchProject: vi.fn(async () => undefined),
  logSystem: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/director-service", () => ({
  applyProductionPlan: vi.fn(),
}));

vi.mock("@/lib/video/script-service", () => ({
  generateScript: vi.fn(),
}));

vi.mock("@/lib/video/image-bridge", () => ({
  generateSceneImage: vi.fn(),
}));

vi.mock("@/lib/video/credits", () => ({
  billImageGeneration: vi.fn(async () => undefined),
  billTts: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/voice-service", () => ({
  resolvePreferredVoice: vi.fn(),
  generateSceneNarration: vi.fn(),
  attachRecordingAsNarration: vi.fn(),
}));

vi.mock("@/lib/video/asset-service", () => ({
  listAssets: vi.fn(async () => []),
}));

vi.mock("@/lib/video/timeline-service", () => ({
  syncVoiceTrack: vi.fn((timeline: unknown) => timeline),
  applyTimelinePatch: vi.fn((timeline: unknown) => timeline),
}));

vi.mock("@/lib/video/audio-engine", () => ({
  ensureMusicBed: vi.fn(),
}));

vi.mock("@/lib/video/storage", () => ({
  isOwnedVideoKey: vi.fn(() => true),
  createVideoPlaybackUrl: vi.fn(async () => "https://r2.test/presigne/master.mp4"),
}));

vi.mock("@/lib/video/render-queue", () => ({
  startRenderJob: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("@/lib/notifications/repository", () => ({
  createNotification: vi.fn(async () => undefined),
}));

vi.mock("@/lib/queue/qstash", () => ({
  publishJsonDestination: vi.fn(async () => ({ ok: true, mode: "published", message: "" })),
}));

// Task 107-a — primitives chat livrées par imports DYNAMIQUES dans
// deliverJobToConversation : mockées au niveau module (vi.mock intercepte
// aussi les import() dynamiques).
const chatRepo = vi.hoisted(() => ({
  appendMessage: vi.fn(async (..._args: unknown[]) => ({ id: "msg-1" })),
  listMessages: vi.fn(async (..._args: unknown[]) => [] as Array<{ role: string; content: string }>),
}));

const artifactRepo = vi.hoisted(() => ({
  createArtifact: vi.fn(async (..._args: unknown[]) => ({ id: "art-1" })),
  listArtifacts: vi.fn(async () => [] as Array<{ videoJobId?: string; videoProjectId?: string }>),
}));

vi.mock("@/lib/chat/repository", () => ({
  appendMessage: chatRepo.appendMessage,
  listMessages: chatRepo.listMessages,
}));

vi.mock("@/lib/domain/artifacts/repository", () => ({
  createArtifact: artifactRepo.createArtifact,
  listArtifacts: artifactRepo.listArtifacts,
}));

// ---------------------------------------------------------------------------
// Imports sujet + mocks pour assertions
// ---------------------------------------------------------------------------

import {
  PRODUCTION_JOBS_COLLECTION,
  advanceProductionJob,
  buildVideoDeliveryMessage,
  createVideoProductionJob,
  deliverJobToConversation,
  type VideoProductionJob,
} from "./production-queue";
import * as queueResume from "@/lib/video/queue-resume";
import { getJob } from "@/lib/video/render-queue";
import { createVideoPlaybackUrl } from "@/lib/video/storage";
import { logSystem } from "@/lib/video/project-service";

/** Document job de base (étape done = transition terminale imminente). */
function baseJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    userId: "user-1",
    projectId: "proj-1",
    prompt: "Une vidéo de présentation du produit",
    title: "Présentation",
    status: "queued",
    stage: "done",
    stageIndex: 6,
    progress: 0.98,
    sceneCursor: 0,
    attempts: 3,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timeline: [{ stage: "done", startedAt: new Date().toISOString() }],
    ...overrides,
  };
}

function setDoc(job: Record<string, unknown>): void {
  firestoreState.docs.set(`${PRODUCTION_JOBS_COLLECTION}/${job.id as string}`, job);
}

function storedJob(jobId: string): Record<string, unknown> {
  return firestoreState.docs.get(`${PRODUCTION_JOBS_COLLECTION}/${jobId}`) ?? {};
}

beforeEach(() => {
  firestoreState.docs.clear();
  firestoreState.txError = null;
  vi.clearAllMocks();
  // Origine canonique : publishProductionTick la résout AVANT d'appeler le
  // mock publishJsonDestination.
  process.env.GEN3IA_APP_ORIGIN = "https://gen3ia.online";
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
  // Couche résiliente PERSISTANTE : les patches (statut terminal, marqueur
  // chatDeliveredAt, checkpoints) sont réellement fusionnés dans les docs.
  vi.mocked(queueResume.saveJobDoc).mockImplementation(async (collection: string, jobId: string, patch: object) => {
    const path = `${collection}/${jobId}`;
    const existing = firestoreState.docs.get(path) ?? {};
    firestoreState.docs.set(path, { ...existing, ...(patch as Record<string, unknown>) });
  });
  vi.mocked(queueResume.createJobDoc).mockImplementation(async (collection: string, jobId: string, payload: object) => {
    firestoreState.docs.set(`${collection}/${jobId}`, { ...(payload as Record<string, unknown>) });
  });
  vi.mocked(queueResume.loadJobDoc).mockImplementation(async (collection: string, jobId: string) => {
    return (firestoreState.docs.get(`${collection}/${jobId}`) ?? null) as never;
  });
  vi.mocked(queueResume.queryJobDocs).mockResolvedValue([] as never);
  chatRepo.appendMessage.mockResolvedValue({ id: "msg-1" } as never);
  chatRepo.listMessages.mockResolvedValue([] as never);
  artifactRepo.createArtifact.mockResolvedValue({ id: "art-1" } as never);
  artifactRepo.listArtifacts.mockResolvedValue([] as never);
  setDoc(baseJob());
});

afterEach(() => {
  delete process.env.GEN3IA_APP_ORIGIN;
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
});

// ---------------------------------------------------------------------------
// 1) createVideoProductionJob — portage de conversationId
// ---------------------------------------------------------------------------

describe("createVideoProductionJob — portage de conversationId (Task 107-a)", () => {
  it("persiste la conversation fournie (trim) dans le doc job", async () => {
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "Une vidéo de présentation du produit",
      conversationId: "  conv-42  ",
    });

    expect(result.jobId).toBe(storedJob(result.jobId).id);
    expect(storedJob(result.jobId).conversationId).toBe("conv-42");
  });

  it("OMET le champ si absent (pas de champ undefined sale)", async () => {
    const result = await createVideoProductionJob({ userId: "user-1", prompt: "Une vidéo de présentation du produit" });

    expect(storedJob(result.jobId)).not.toHaveProperty("conversationId");
  });

  it("ignore une conversation vide ou surdimensionnée (> 128) — job hors chat", async () => {
    const longId = "c".repeat(129);
    const result = await createVideoProductionJob({ userId: "user-1", prompt: "Une vidéo de présentation du produit", conversationId: longId });

    expect(storedJob(result.jobId)).not.toHaveProperty("conversationId");
  });
});

// ---------------------------------------------------------------------------
// 1 bis) createVideoProductionJob — ROBUSTESSE bornes (fix captures 13:02)
// ---------------------------------------------------------------------------
// Une demande « 5 secondes » est servie à la durée minimale du pipeline
// (10 s) au lieu d'échouer en validation ; un brief trop court est enrichi
// du titre ; un titre trop court est déduit du brief. La plateforme AJUSTE
// ce qu'elle peut ajuster — elle ne refuse JAMAIS une demande réalisable
// pour un paramètre hors bornes (exigence : chaque tâche réellement exécutée).
describe("createVideoProductionJob — bornes pipeline appliquées à l'entrée (fix captures 13:02)", () => {
  it("BORNE une durée inférieure au minimum (5 s → 10 s) au lieu d'échouer", async () => {
    // AVANT le fix : VideoProjectCreateSchema.parse lève (min 10) →
    // « Le lancement de la production vidéo a échoué » (capture 2).
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "Créé une vidéo de 5s d'un bébé qui marche",
      options: { targetDurationSec: 5 },
    });

    expect(storedJob(result.jobId).options).toMatchObject({ targetDurationSec: 10 });
  });

  it("BORNE une durée supérieure au plafond (> 3600 s → 3600 s)", async () => {
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "Une longue vidéo documentaire sur l'histoire du café camerounais",
      options: { targetDurationSec: 9999 },
    });

    expect(storedJob(result.jobId).options).toMatchObject({ targetDurationSec: 3600 });
  });

  it("CONSERVE une durée dans les bornes (180 s)", async () => {
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "Une vidéo de présentation du produit",
      options: { targetDurationSec: 180 },
    });

    expect(storedJob(result.jobId).options).toMatchObject({ targetDurationSec: 180 });
  });

  it("ENRICHIT un brief trop court du titre (DirectorBriefSchema min 10) au lieu de lever", async () => {
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "bébé",
      title: "Bébé qui marche tranquillement dans le salon",
    });

    expect(storedJob(result.jobId).prompt.length).toBeGreaterThanOrEqual(10);
    expect(storedJob(result.jobId).prompt).toContain("bébé");
  });

  it("DÉDUIT le titre du brief quand le titre fourni fait moins de 3 caractères", async () => {
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "Une vidéo de présentation du nouveau produit",
      title: "a",
    });

    expect((storedJob(result.jobId).title as string).length).toBeGreaterThanOrEqual(3);
  });

  it("accepte un prompt exactement à la limite (10 caractères)", async () => {
    const result = await createVideoProductionJob({
      userId: "user-1",
      prompt: "vidéo bébé", // exactement 10 caractères
    });

    expect(storedJob(result.jobId).prompt).toBe("vidéo bébé");
  });
});

// ---------------------------------------------------------------------------
// 2) advanceProductionJob — livraison chat à la transition terminale
// ---------------------------------------------------------------------------

describe("advanceProductionJob — livraison chat à la complétion (Task 107-a)", () => {
  const completedRenderJob = {
    id: "render-1",
    status: "completed",
    progress: 1,
    output: { r2Key: "videos/user-1/proj-1/render/master.mp4" },
    exports: [],
  };

  function jobAtDone(overrides: Record<string, unknown> = {}): void {
    setDoc(baseJob({ renderJobId: "render-1", conversationId: "conv-1", ...overrides }));
  }

  it("job avec conversationId → message assistant avec URL master, marqueur chatDeliveredAt posé, artefact de livraison", async () => {
    jobAtDone();
    vi.mocked(getJob).mockResolvedValue(completedRenderJob as never);

    const result = await advanceProductionJob("job-1");

    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
    // Le message monte DANS la conversation d'origine, au bon format.
    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);
    const message = chatRepo.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(message.conversationId).toBe("conv-1");
    expect(message.userId).toBe("user-1");
    expect(message.role).toBe("assistant");
    expect(message.generationStatus).toBe("complete");
    const content = String(message.content);
    expect(content).toContain("Votre vidéo est prête");
    // URL du master = MÊME source que la carte client (output.r2Key présigné).
    expect(content).toContain("https://r2.test/presigne/master.mp4");
    expect(content).toContain("/studio/video/proj-1");
    expect(content).toContain("Présentation");
    // Marqueur d'idempotence persisté sur le doc job.
    expect(typeof storedJob("job-1").chatDeliveredAt).toBe("string");
    expect(String(storedJob("job-1").chatDeliveredAt).length).toBeGreaterThan(0);
    // Artefact de livraison (l'artefact de lancement n'existe pas ici).
    expect(artifactRepo.createArtifact).toHaveBeenCalledTimes(1);
    const artifactInput = artifactRepo.createArtifact.mock.calls[0][0] as Record<string, unknown>;
    expect(artifactInput).toMatchObject({ type: "video", conversationId: "conv-1", videoProjectId: "proj-1", videoJobId: "job-1", note: "Vidéo terminée" });
  });

  it("IDEMPOTENCE : second tick sur le job terminal → PAS de second message", async () => {
    jobAtDone();
    vi.mocked(getJob).mockResolvedValue(completedRenderJob as never);

    await advanceProductionJob("job-1");
    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);

    // Second passage (tick QStash tardif, sondage…) : le claim retombe sur
    // un job terminal — le marqueur chatDeliveredAt relu du doc court-circuite.
    await advanceProductionJob("job-1");

    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);
    expect(artifactRepo.createArtifact).toHaveBeenCalledTimes(1);
  });

  it("artefact de lancement DÉJÀ présent → aucun artefact dupliqué (message quand même livré)", async () => {
    jobAtDone();
    vi.mocked(getJob).mockResolvedValue(completedRenderJob as never);
    artifactRepo.listArtifacts.mockResolvedValue([{ videoJobId: "job-1", videoProjectId: "proj-1" }] as never);

    await advanceProductionJob("job-1");

    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);
    expect(artifactRepo.createArtifact).not.toHaveBeenCalled();
  });

  it("échec de signature du master → message livré SANS URL (jamais de livraison bloquée)", async () => {
    jobAtDone();
    vi.mocked(getJob).mockResolvedValue({ id: "render-1", status: "completed", progress: 1, exports: [] } as never);
    vi.mocked(createVideoPlaybackUrl).mockRejectedValue(new Error("R2 indisponible"));

    const result = await advanceProductionJob("job-1");

    expect(result.status).toBe("completed");
    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);
    const content = String((chatRepo.appendMessage.mock.calls[0][0] as Record<string, unknown>).content);
    expect(content).not.toContain("https://r2.test");
    expect(content).toContain("carte vidéo");
  });

  it("job terminal SANS conversationId → aucune livraison, aucun crash", async () => {
    setDoc(baseJob({ renderJobId: "render-1" })); // pas de conversationId
    vi.mocked(getJob).mockResolvedValue(completedRenderJob as never);

    const result = await advanceProductionJob("job-1");

    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
    expect(chatRepo.appendMessage).not.toHaveBeenCalled();
    expect(artifactRepo.createArtifact).not.toHaveBeenCalled();
    expect(storedJob("job-1")).not.toHaveProperty("chatDeliveredAt");
  });

  it("échec d'appendMessage → AUCUN marqueur posé (reprise possible), tick NON-FAILING", async () => {
    jobAtDone();
    vi.mocked(getJob).mockResolvedValue(completedRenderJob as never);
    chatRepo.appendMessage.mockRejectedValueOnce(new Error("Conversation introuvable."));

    const result = await advanceProductionJob("job-1");

    // Le tick terminal reste un SUCCÈS : la livraison n'est jamais bloquante.
    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
    // Task 113 — LIVRER D'ABORD, MARQUER ENSUITE : l'échec du message laisse
    // le marqueur ABSENT (jamais posé) → la reprise est garantie au passage
    // suivant (l'ancien design posait puis effaçait — l'effacement pouvait
    // lui-même échouer et perdre le message pour toujours).
    expect(storedJob("job-1")).not.toHaveProperty("chatDeliveredAt");
    // Incident journalisé (logSystem, jamais de console.log ni de throw).
    expect(logSystem).toHaveBeenCalledWith("proj-1", expect.stringMatching(/Livraison chat/));
    // Reprise : le passage suivant livre bien le message.
    chatRepo.appendMessage.mockResolvedValue({ id: "msg-2" } as never);
    await advanceProductionJob("job-1");
    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(2);
    expect(String(storedJob("job-1").chatDeliveredAt).length).toBeGreaterThan(0);
  });

  it("anti-doublon par LECTURE : message déjà dans le fil + marqueur absent → PAS de doublon, marqueur re-posé", async () => {
    // Cas « message écrit mais marqueur jamais posé » (panne du magasin à
    // l'instant du marquage) : la lecture du fil prouve la livraison déjà
    // faite — le message n'est PAS dupliqué et le marqueur est réparé.
    jobAtDone();
    vi.mocked(getJob).mockResolvedValue(completedRenderJob as never);
    chatRepo.listMessages.mockResolvedValue([
      { role: "assistant", content: "Votre vidéo est prête 🎬 ... /studio/video/proj-1 ..." },
    ] as never);

    const result = await advanceProductionJob("job-1");

    expect(result.status).toBe("completed");
    expect(chatRepo.appendMessage).not.toHaveBeenCalled();
    expect(artifactRepo.createArtifact).not.toHaveBeenCalled();
    // Le marqueur manquant a été réparé (best-effort).
    expect(typeof storedJob("job-1").chatDeliveredAt).toBe("string");
  });

  it("échec du rendu rattaché → message d'échec FR livré (étape, atelier, relance)", async () => {
    setDoc(baseJob({ renderJobId: "render-1", conversationId: "conv-1" }));
    vi.mocked(getJob).mockResolvedValue({ id: "render-1", status: "failed", progress: 0.9, errorMessage: "FFmpeg indisponible", exports: [] } as never);

    const result = await advanceProductionJob("job-1");

    expect(result.status).toBe("failed");
    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);
    const message = chatRepo.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    const content = String(message.content);
    expect(content).toContain("n'a pas abouti");
    // La production était à l'étape finale (done) quand le rendu a échoué.
    expect(content).toContain("finalisation");
    expect(content).toContain("FFmpeg indisponible");
    expect(content).toContain("/studio/video/proj-1");
    expect(content).toContain("video.revise");
  });
});

// ---------------------------------------------------------------------------
// 3) deliverJobToConversation — contrat direct (statuts non terminaux, marqueur)
// ---------------------------------------------------------------------------

describe("deliverJobToConversation — garde de conditions", () => {
  it("job NON terminal (queued) → aucune livraison, aucun marqueur", async () => {
    const job = baseJob({ conversationId: "conv-1" }) as unknown as VideoProductionJob;

    await deliverJobToConversation(job);

    expect(chatRepo.appendMessage).not.toHaveBeenCalled();
    expect(queueResume.saveJobDoc).not.toHaveBeenCalled();
  });

  it("job terminal DÉJÀ livré (chatDeliveredAt présent) → no-op strict", async () => {
    const job = baseJob({ status: "completed", conversationId: "conv-1", chatDeliveredAt: new Date().toISOString() }) as unknown as VideoProductionJob;

    await deliverJobToConversation(job);

    expect(chatRepo.appendMessage).not.toHaveBeenCalled();
    expect(queueResume.saveJobDoc).not.toHaveBeenCalled();
  });

  it("marquage final impossible (panne magasin au marquage) → message QUAND MÊME livré, réparation au passage suivant", async () => {
    // Task 113 — le marquage est best-effort EN FIN de livraison : une panne
    // du magasin à ce moment n'empêche plus la livraison du message.
    vi.mocked(queueResume.saveJobDoc).mockRejectedValue(new Error("Panne magasin"));
    const job = baseJob({ status: "completed", conversationId: "conv-1" }) as unknown as VideoProductionJob;

    await expect(deliverJobToConversation(job)).resolves.toBeUndefined();

    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1);
    expect(storedJob("job-1")).not.toHaveProperty("chatDeliveredAt");
    // Réparation au passage suivant : l'anti-doublon par LECTURE reconnaît
    // le message déjà livré, pose le marqueur (récupéré du rejet) et sort.
    chatRepo.listMessages.mockResolvedValue([
      { role: "assistant", content: "Votre vidéo est prête 🎬 ... /studio/video/proj-1 ..." },
    ] as never);
    vi.mocked(queueResume.saveJobDoc).mockRejectedValueOnce(new Error("Panne magasin"));
    const job2 = baseJob({ status: "completed", conversationId: "conv-1" }) as unknown as VideoProductionJob;
    await expect(deliverJobToConversation(job2)).resolves.toBeUndefined();
    expect(chatRepo.appendMessage).toHaveBeenCalledTimes(1); // pas de doublon
  });
});

// ---------------------------------------------------------------------------
// 4) buildVideoDeliveryMessage — contenu FR (pure)
// ---------------------------------------------------------------------------

describe("buildVideoDeliveryMessage — contenu FR", () => {
  const base = { title: "Présentation", projectId: "proj-1", stage: "done" } as const;

  it("completed : master URL + atelier + relance video.revise + avertissements (3 max)", () => {
    const content = buildVideoDeliveryMessage({
      ...base,
      status: "completed",
      masterUrl: "https://r2.test/presigne/master.mp4",
      warnings: ["w1", "w2", "w3", "w4"],
    });
    expect(content).toContain("Votre vidéo est prête 🎬");
    expect(content).toContain("« Présentation »");
    expect(content).toContain("https://r2.test/presigne/master.mp4");
    expect(content).toContain("/studio/video/proj-1");
    expect(content).toContain("video.revise");
    expect(content).toContain("w1");
    expect(content).toContain("w3");
    expect(content).not.toContain("w4"); // borné à 3 avertissements
  });

  it("completed sans master URL : la lecture renvoie vers la carte vidéo", () => {
    const content = buildVideoDeliveryMessage({ ...base, status: "completed" });
    expect(content).not.toMatch(/https?:\/\//);
    expect(content).toContain("carte vidéo");
  });

  it("failed : étape lisible + erreur tronquée à 200 caractères + atelier", () => {
    const content = buildVideoDeliveryMessage({
      ...base,
      status: "failed",
      stage: "render",
      error: "x".repeat(500),
    });
    expect(content).toContain("n'a pas abouti");
    expect(content).toContain("montage et rendu");
    expect(content).toContain("x".repeat(200));
    expect(content).not.toContain("x".repeat(201));
    expect(content).toContain("/studio/video/proj-1");
  });

  it("cancelled : confirmation + atelier", () => {
    const content = buildVideoDeliveryMessage({ ...base, status: "cancelled" });
    expect(content).toContain("annulée");
    expect(content).toContain("/studio/video/proj-1");
  });
});
