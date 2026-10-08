import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 106-a — SURFACE CHAT/OUTILS VIDÉO COMPLÈTE : video.create enrichi
 * (paramètres de production), video.status (suivi) et video.revise
 * (révision/pilotage). Les tests valident les schémas d'entrée, le filtre
 * d'options et les comportements d'exécution MOCKÉS (aucun appel réseau).
 */

import { createVideoTool, sanitizeProductionOptions } from "./create-video";
import { videoStatusTool } from "./video-status";
import { videoReviseTool } from "./video-revise";

describe("outil video.create — schéma enrichi (Task 106-a)", () => {
  it("accepte une entrée minimale valide", () => {
    const parsed = createVideoTool.inputSchema.parse({ prompt: "Vidéo de présentation de ma boutique de thé" });
    expect(parsed.prompt).toBe("Vidéo de présentation de ma boutique de thé");
  });

  it("accepte TOUS les paramètres de production (relais pipeline)", () => {
    const parsed = createVideoTool.inputSchema.parse({
      prompt: "Documentaire sur les récifs coralliens",
      title: "Récifs",
      aspectRatio: "21:9",
      resolution: "4K",
      targetDurationSec: 600,
      language: "fr",
      style: "cinématique",
      audience: "plongeurs",
      platform: "YouTube",
      musicMood: "emotionnel",
      voiceEnabled: true,
      subtitlesEnabled: true,
      derivedTargets: ["youtube_16_9", "shorts_9_16"],
    });
    expect(parsed.targetDurationSec).toBe(600);
    expect(parsed.aspectRatio).toBe("21:9"); // 5 ratios alignés pipeline
    expect(parsed.derivedTargets).toEqual(["youtube_16_9", "shorts_9_16"]);
  });

  it("refuse un prompt trop court et une durée hors bornes", () => {
    expect(() => createVideoTool.inputSchema.parse({ prompt: "court" })).toThrow();
    expect(() =>
      createVideoTool.inputSchema.parse({ prompt: "Une vidéo de présentation correcte", targetDurationSec: 5 }),
    ).toThrow();
    expect(() =>
      createVideoTool.inputSchema.parse({ prompt: "Une vidéo de présentation correcte", targetDurationSec: 9999 }),
    ).toThrow();
  });

  it("refuse un ratio hors pipeline et un format dérivé inconnu", () => {
    expect(() =>
      createVideoTool.inputSchema.parse({ prompt: "Une vidéo de présentation correcte", aspectRatio: "3:2" }),
    ).toThrow();
    expect(() =>
      createVideoTool.inputSchema.parse({ prompt: "Une vidéo de présentation correcte", derivedTargets: ["snapchat_9_16"] }),
    ).toThrow();
  });
});

describe("sanitizeProductionOptions (Task 106-a)", () => {
  it("relaît les options reconnues et écarte les inconnues/vides", () => {
    const options = sanitizeProductionOptions({
      targetDurationSec: 90,
      aspectRatio: "9:16",
      musicMood: "energique",
      unknownKey: "ignored",
      emptyString: "",
      nested: { evil: true },
      derivedTargets: ["tiktok_9_16"],
    });
    expect(options).toEqual({
      targetDurationSec: 90,
      aspectRatio: "9:16",
      musicMood: "energique",
      derivedTargets: ["tiktok_9_16"],
    });
  });

  it("entrée non-objet → objet vide (robustesse planificateur)", () => {
    expect(sanitizeProductionOptions(null)).toEqual({});
    expect(sanitizeProductionOptions("texte")).toEqual({});
    expect(sanitizeProductionOptions(undefined)).toEqual({});
  });
});

describe("outil video.status — schéma et exécution (Task 106-a)", () => {
  const productionQueue = vi.hoisted(() => ({ getProductionJob: vi.fn(), listProductionJobs: vi.fn() }));

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.doMock("@/lib/video/production-queue", () => productionQueue, { virtual: true });
  });

  afterEach(() => {
    vi.doUnmock("@/lib/video/production-queue");
  });

  it("exige jobId OU projectId", () => {
    expect(() => videoStatusTool.inputSchema.parse({})).toThrow(/jobId ou projectId/i);
    expect(() => videoStatusTool.inputSchema.parse({ jobId: "job-1" })).not.toThrow();
    expect(() => videoStatusTool.inputSchema.parse({ projectId: "proj-1" })).not.toThrow();
  });

  it("retourne l'état consolidé d'une production en cours", async () => {
    productionQueue.listProductionJobs.mockResolvedValue([
      {
        id: "job-1",
        userId: "user-1",
        projectId: "proj-1",
        status: "processing",
        stage: "assets",
        progress: 0.45,
        sceneCursor: 3,
        warnings: ["Scène 2 : image non générée (erreur transitoire) — reprise au prochain tick"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
        attempts: 5,
        retryCount: 0,
      },
    ]);
    const output = await videoStatusTool.execute({ projectId: "proj-1" }, { userId: "user-1" });
    expect(output.found).toBe(true);
    expect(output.stage).toBe("assets");
    expect(output.progress).toBeCloseTo(0.45);
    expect(output.sceneCursor).toBe(3);
    expect(output.warnings?.length).toBe(1);
    expect(output.message).toMatch(/visuels/i);
  });

  it("production terminée → message clair (URL résolue par le helper séparé)", async () => {
    productionQueue.listProductionJobs.mockResolvedValue([
      {
        id: "job-1",
        userId: "user-1",
        projectId: "proj-1",
        status: "completed",
        stage: "done",
        progress: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timeline: [],
        attempts: 9,
        retryCount: 0,
      },
    ]);
    const output = await videoStatusTool.execute({ projectId: "proj-1" }, { userId: "user-1" });
    expect(output.found).toBe(true);
    expect(output.message).toMatch(/terminée/i);
  });

  it("job d'un AUTRE utilisateur → introuvable (pas de fuite d'existence)", async () => {
    productionQueue.getProductionJob.mockResolvedValue({
      id: "job-2",
      userId: "user-OTHER",
      projectId: "proj-2",
      status: "processing",
      stage: "script",
      progress: 0.1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timeline: [],
      attempts: 1,
      retryCount: 0,
    });
    const output = await videoStatusTool.execute({ jobId: "job-2" }, { userId: "user-1" });
    expect(output.found).toBe(false);
    expect(output.message).toMatch(/introuvable|non autorisé/i);
  });

  it("aucune production → message FR actionnable", async () => {
    productionQueue.listProductionJobs.mockResolvedValue([]);
    const output = await videoStatusTool.execute({ projectId: "proj-404" }, { userId: "user-1" });
    expect(output.found).toBe(false);
    expect(output.message).toMatch(/aucune production/i);
  });
});

describe("outil video.revise — schéma et exécution (Task 106-a)", () => {
  it("valide l'action et borne les cibles d'export", () => {
    expect(() => videoReviseTool.inputSchema.parse({ projectId: "p1" })).not.toThrow();
    expect(() => videoReviseTool.inputSchema.parse({ projectId: "p1", action: "explode" })).toThrow();
    expect(() =>
      videoReviseTool.inputSchema.parse({ projectId: "p1", action: "add_exports", targets: ["tiktok_9_16"] }),
    ).not.toThrow();
    expect(() =>
      videoReviseTool.inputSchema.parse({ projectId: "p1", action: "add_exports", targets: ["inconnu"] }),
    ).toThrow();
  });

  it("action revise sans instruction → message FR clair (échec non appliqué)", async () => {
    const output = await videoReviseTool.execute({ projectId: "p1" }, { userId: "user-1" });
    expect(output.applied).toBe(false);
    expect(output.message).toMatch(/instruction/i);
  });

  it("action de rendu sans job → message FR actionnable", async () => {
    const renderQueue = vi.hoisted(() => ({ listJobs: vi.fn(), getOwnedJobOrThrow: vi.fn() }));
    vi.doMock("@/lib/video/render-queue", () => renderQueue, { virtual: true });
    renderQueue.listJobs.mockResolvedValue([]);
    try {
      const output = await videoReviseTool.execute({ projectId: "p1", action: "pause_render" }, { userId: "user-1" });
      expect(output.applied).toBe(false);
      expect(output.message).toMatch(/aucun rendu/i);
    } finally {
      vi.doUnmock("@/lib/video/render-queue");
    }
  });
});
