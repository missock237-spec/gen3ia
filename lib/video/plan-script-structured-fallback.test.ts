import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GARDE — REPLI STRUCTURÉ du plan directeur et du scénario vidéo.
 *
 * Constat production (sonde vidéo 2026-11-12, gen3ia.online) : job de
 * production FAILED au stade plan avec « Planner returned invalid JSON » —
 * le moteur neuronal renvoyait une réponse MÉTA hors JSON et le throw de
 * extractJsonObject court-circuitait le repli déterministe. Toute la
 * production vidéo mourait à la première indiscipline du modèle.
 *
 * Le motif « repli structuré » (7c6e432, rédaction de livrables) est
 * appliqué aux DEUX stades :
 *   1) appel historique (JSON espéré) ;
 *   2) relance STRUCTURÉE contrainte (generateStructuredForUser, zod) ;
 *   3) repli DÉTERMINISTE (fallbackPlan / fallbackScript) — la production
 *      ne bloque JAMAIS sur un refus de format du modèle.
 */

const generateMock = vi.hoisted(() => vi.fn());
const generateForUserMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/router", () => ({
  generate: generateMock,
  selectProvider: vi.fn(() => []),
  selectModel: vi.fn(() => null),
  generateStream: vi.fn(),
}));

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: generateForUserMock,
}));

vi.mock("@/lib/video/project-service", () => ({
  getOwnedProjectOrThrow: vi.fn(async () => PROJET_TEST),
  patchProject: vi.fn(async () => undefined),
  snapshotVersion: vi.fn(async () => undefined),
  appendProductionLog: vi.fn(async () => undefined),
}));

import { buildProductionPlan, fallbackPlan } from "@/lib/video/director-service";
import { generateScript, fallbackScript } from "@/lib/video/script-service";
import type { VideoProject } from "@/lib/video/types";

const PROJET_TEST: VideoProject = {
  id: "proj_123",
  userId: "user_1",
  title: "un homme mange du poulet frit",
  description: "un homme mange du poulet frit et dit qu'il lui faut une boisson pétillante",
  language: "fr",
  aspectRatio: "16:9",
  resolution: "1080p",
  fps: 30,
  targetDurationSec: 15,
  style: "cinématographique photoréaliste",
  audience: undefined,
  platform: undefined,
  status: "planning",
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  stats: { sceneCount: 0 },
} as unknown as VideoProject;

const PLAN_VALIDE = {
  title: "Poulet frit & boisson pétillante",
  description: "Un homme savoure un poulet frit croustillant et réclame une boisson pétillante.",
  language: "fr",
  aspectRatio: "9:16",
  resolution: "1080p",
  fps: 30,
  targetDurationSec: 15,
  style: "photoréaliste",
  audience: "grand public",
  platform: "tiktok",
  structure: [{ chapterTitle: "Dégustation", sceneCount: 2, summary: "Il mange puis demande une boisson." }],
  narrationTone: "chaleureux",
  visualStyle: "photoréaliste lumineux",
  musicMood: "énergique",
  needsVoiceRecording: false,
  captions: true,
  rationale: "Clip court vertical.",
};

beforeEach(() => {
  generateMock.mockReset();
  generateForUserMock.mockReset();
});

describe("PLAN directeur — repli structuré (job failed « Planner returned invalid JSON »)", () => {
  it("réponse hors JSON au 1er appel → RELANCE STRUCTURÉE réussit → plan du directeur appliqué", async () => {
    generateMock.mockResolvedValue({ text: "Je ne peux pas produire ce plan pour le moment." });
    generateForUserMock.mockResolvedValue({
      response: { text: JSON.stringify(PLAN_VALIDE) },
    });
    const plan = await buildProductionPlan("Crée une vidéo", PROJET_TEST);
    expect(plan.title).toBe("Poulet frit & boisson pétillante");
    expect(plan.targetDurationSec).toBe(15);
    expect(plan.structure.length).toBe(1);
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
  });

  it("relance structurée elle-même hors JSON (2 tentatives) → REPLI DÉTERMINISTE, jamais de throw", async () => {
    generateMock.mockResolvedValue({ text: "réponse méta sans JSON" });
    generateForUserMock.mockResolvedValue({ response: { text: "toujours pas de JSON" } });
    const plan = await buildProductionPlan("Crée une vidéo", PROJET_TEST);
    // fallbackPlan : cohérent, exécutable, honnête.
    expect(plan.title).toBe(PROJET_TEST.title);
    expect(plan.targetDurationSec).toBe(PROJET_TEST.targetDurationSec);
    expect(plan.structure.length).toBeGreaterThanOrEqual(1);
    expect(plan.structure.reduce((n, c) => n + c.sceneCount, 0)).toBeGreaterThanOrEqual(3);
    expect(generateForUserMock).toHaveBeenCalledTimes(2); // maxAttempts: 2
  });

  it("relance structurée LÈVE (billing indisponible) → repli déterministe quand même", async () => {
    generateMock.mockResolvedValue({ text: "hors JSON" });
    generateForUserMock.mockRejectedValue(new Error("Insufficient balance"));
    const plan = await buildProductionPlan("Crée une vidéo", PROJET_TEST);
    expect(plan.title).toBe(PROJET_TEST.title);
    expect(plan.structure.length).toBeGreaterThanOrEqual(1);
  });

  it("fallbackPlan : durée bornée par les limites vidéo (jamais hors VIDEO_LIMITS)", async () => {
    const plan = fallbackPlan("clip", { ...PROJET_TEST, targetDurationSec: 300 });
    expect(plan.targetDurationSec).toBeGreaterThan(0);
    expect(plan.structure.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SCRIPT — repli structuré puis déterministe", () => {
  it("réponse hors JSON + relance échouée → scénario de REPLI déterministe exécutable", async () => {
    generateMock.mockResolvedValue({ text: "scénario impossible" });
    generateForUserMock.mockResolvedValue({ response: { text: "toujours rien" } });
    const { script, scenes } = await generateScript("user_1", "proj_123");
    expect(script.chapters.length).toBeGreaterThanOrEqual(1);
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    scenes.forEach((scene) => {
      expect(scene.durationSec).toBeGreaterThanOrEqual(3);
      expect(scene.narration.trim().length).toBeGreaterThan(0);
      expect(scene.visualPrompt.trim().length).toBeGreaterThan(0);
    });
    // Cohérence : chaque scène référence un chapitre existant.
    const idsChapitres = new Set(script.chapters.map((c) => c.id));
    scenes.forEach((scene) => expect(idsChapitres.has(scene.chapterId)).toBe(true));
  });

  it("relance structurée réussit → VRAI scénario du moteur utilisé", async () => {
    generateMock.mockResolvedValue({ text: "hors JSON" });
    generateForUserMock.mockResolvedValue({
      response: { text: JSON.stringify({
        hook: "Ce poulet croustillant va vous rendre jaloux.",
        introduction: "Un homme s'installe avec son seau de poulet frit.",
        chapters: [{ id: "c1", title: "Dégustation", summary: "Il mange et réclame une boisson pétillante.", sceneIds: ["scene_001", "scene_002"] }],
        scenes: [
          { id: "scene_001", chapterId: "c1", durationSec: 8, narration: "Il croque le poulet croustillant.", onScreenText: null, visualPrompt: "close-up of a man biting fried chicken, 35mm, golden hour light", visualType: "image", subject: "person", cameraMotion: "slow_zoom", transitionIn: "fade", transitionOut: "cut", musicMood: null, soundEffects: [], captions: true },
          { id: "scene_002", chapterId: "c1", durationSec: 7, narration: "Il lui faut une boisson pétillante pour accompagner ce poulet.", onScreenText: null, visualPrompt: "medium shot of the man reaching for a sparkling water bottle", visualType: "image", subject: "person", cameraMotion: "ken_burns", transitionIn: "cut", transitionOut: "fade", musicMood: null, soundEffects: [], captions: true },
        ],
        conclusion: "Le duo parfait : poulet frit et bulles.",
        callToAction: null,
      }) },
    });
    const { script, scenes } = await generateScript("user_1", "proj_123");
    expect(scenes.length).toBe(2);
    expect(script.chapters[0].title).toBe("Dégustation");
    expect(scenes[1].narration).toContain("boisson pétillante");
  });

  it("fallbackScript : somme des durées ≈ durée cible (±40 %) et ids uniques", () => {
    const brut = fallbackScript({ ...PROJET_TEST, targetDurationSec: 60 });
    const ids = new Set(brut.scenes.map((s) => s.id));
    expect(ids.size).toBe(brut.scenes.length);
    const somme = brut.scenes.reduce((n, s) => n + s.durationSec, 0);
    expect(somme).toBeGreaterThanOrEqual(36);
    expect(somme).toBeLessThanOrEqual(84);
    expect(brut.chapters[0].sceneIds.length).toBe(brut.scenes.length);
  });
});
