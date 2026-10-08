import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests du QC missing_asset (Task 106-c) — les scènes attendues (scénario)
 * absentes des segments réellement rendus doivent produire une issue
 * `missing_asset` (buildRenderPlan ignore silencieusement les scènes sans
 * image : cette passe rend le manque VISIBLE).
 *
 * Helpers PURES testés seuls + intégration analyzeRenderedMaster avec
 * FFmpeg/ffprobe mockés et relecture projet mockée (couche résiliente).
 */

vi.mock("@/lib/video/ffmpeg", () => ({
  runFfmpeg: vi.fn(async () => {
    throw new Error("ffmpeg mocké (tests unitaires QC)");
  }),
  probeMedia: vi.fn(),
}));

vi.mock("@/lib/video/queue-resume", () => ({
  loadJobDoc: vi.fn(),
}));

vi.mock("@/lib/video/project-service", () => ({
  PROJECTS_COLLECTION: "videoProjects",
}));

import {
  analyzeRenderedMaster,
  decideAutoFix,
  detectMissingAssetIssues,
  expectedSceneNumber,
  type ExpectedScene,
} from "./qc-service";
import { probeMedia } from "@/lib/video/ffmpeg";
import { loadJobDoc } from "@/lib/video/queue-resume";

/** Plan minimal : deux segments rendus (scènes 1 et 3 sur 3 attendues). */
function fakePlan(segments: Array<{ sceneId: string }>) {
  return {
    planId: "plan-1",
    projectId: "proj-1",
    jobId: "job-1",
    resolution: "1080p",
    aspectRatio: "16:9",
    fps: 30,
    output: { videoCodec: "h264", audioCodec: "aac", container: "mp4" },
    segments: segments.map((s, index) => ({
      index,
      sceneId: s.sceneId,
      durationSec: 5,
      imageR2Keys: ["img.r2"],
      motion: { preset: "slow_zoom", intensity: 1, keyframes: [] },
      effects: [],
      textOverlays: [],
      transitionIn: "fade",
      transitionOut: "cut",
    })),
    transitions: [],
    audioMix: { narration: [], music: [], sfx: [], ducking: { enabled: false, nominalVolume: 1, duckedVolume: 0.2, attackSec: 0.2, releaseSec: 0.4 }, targetLoudnessDb: -14 },
    derivedTargets: [],
    estimatedSec: segments.length * 5,
  } as unknown as Parameters<typeof analyzeRenderedMaster>[0]["plan"];
}

const probeOk = {
  durationSec: 10,
  hasAudio: true,
  width: 1920,
  height: 1080,
  fps: 30,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeMedia).mockResolvedValue(probeOk as never);
  vi.mocked(loadJobDoc).mockResolvedValue(null as never);
});

describe("detectMissingAssetIssues (pur)", () => {
  it("toutes les scènes rendues → aucune issue", () => {
    const expected: ExpectedScene[] = [{ id: "s1", index: 0 }, { id: "s2", index: 1 }];
    expect(detectMissingAssetIssues(expected, [{ sceneId: "s1", index: 0 }, { sceneId: "s2", index: 1 }])).toEqual([]);
  });

  it("scène absente → une issue missing_asset warning, détail FR numéroté, pas de segmentIndex", () => {
    const expected: ExpectedScene[] = [{ id: "s1", index: 0 }, { id: "s2", index: 1 }, { id: "s3", index: 2 }];
    const issues = detectMissingAssetIssues(expected, [{ sceneId: "s1", index: 0 }, { sceneId: "s3", index: 2 }]);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.kind).toBe("missing_asset");
    expect(issue.severity).toBe("warning");
    expect(issue.detail).toContain("Scène 2");
    expect(issue.detail).toContain("absente du montage final");
    expect(issue.segmentIndex).toBeUndefined(); // aucun segment fantôme pour l'autofix
    expect(issue.suggestedFix?.type).toBe("regenerate_segment");
    expect(issue.suggestedFix?.payload).toEqual({ sceneIds: ["s2"] });
  });

  it("plusieurs scènes absentes → UNE issue listant les numéros", () => {
    const expected: ExpectedScene[] = [{ id: "s1", index: 0 }, { id: "s2", index: 1 }, { id: "s3", index: 2 }];
    const issues = detectMissingAssetIssues(expected, [{ sceneId: "s3", index: 2 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("Scènes 1, 2");
    expect(issues[0].suggestedFix?.payload).toEqual({ sceneIds: ["s1", "s2"] });
  });

  it("numérotation : champ index du scénario prioritaire, position en repli", () => {
    expect(expectedSceneNumber({ id: "x", index: 4 }, 0)).toBe(5);
    expect(expectedSceneNumber({ id: "x" }, 2)).toBe(3);
    expect(expectedSceneNumber({ id: "x", index: -1 }, 2)).toBe(3); // index invalide → position
  });
});

describe("decideAutoFix × missing_asset (pas de boucle de correction)", () => {
  it("une issue missing_asset seule ne déclenche AUCUN re-rendu (warning + pas de segmentIndex)", () => {
    const expected: ExpectedScene[] = [{ id: "s1", index: 0 }, { id: "s2", index: 1 }];
    const issues = detectMissingAssetIssues(expected, [{ sceneId: "s1", index: 0 }]);
    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      issues,
      metrics: {},
    };
    // passed ne compte que les critical → missing_asset (warning) la laisse true
    expect(report.passed).toBe(true);
    const decision = decideAutoFix({ ...report, passed: false }, fakePlan([{ sceneId: "s1" }]));
    expect(decision.action).toBe("accept");
    expect(decision.reRenderSegments).toEqual([]);
  });
});

describe("analyzeRenderedMaster — intégration missing_asset", () => {
  it("émet l'issue quand des scènes attendues sont fournies explicitement", async () => {
    const report = await analyzeRenderedMaster({
      masterFile: "/tmp/master.mp4",
      tmpDir: "/tmp",
      plan: fakePlan([{ sceneId: "s1" }, { sceneId: "s3" }]),
      expectedDurationSec: 10,
      subtitlesEnabled: false,
      expectedScenes: [{ id: "s1", index: 0 }, { id: "s2", index: 1 }, { id: "s3", index: 2 }],
    });
    const missing = report.issues.filter((i) => i.kind === "missing_asset");
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("Scène 2");
    expect(loadJobDoc).not.toHaveBeenCalled(); // scènes explicites → pas de relecture projet
  });

  it("recharge les scènes depuis le projet (couche résiliente) quand elles ne sont pas fournies", async () => {
    vi.mocked(loadJobDoc).mockResolvedValue({
      id: "proj-1",
      script: {
        scenes: [
          { id: "s1", index: 0 },
          { id: "s2", index: 1 },
        ],
      },
    } as never);
    const report = await analyzeRenderedMaster({
      masterFile: "/tmp/master.mp4",
      tmpDir: "/tmp",
      plan: fakePlan([{ sceneId: "s1" }]),
      expectedDurationSec: 5,
      subtitlesEnabled: false,
    });
    const missing = report.issues.filter((i) => i.kind === "missing_asset");
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("Scène 2");
  });

  it("projet/scénario indisponible → pas de fausse alerte (passe silencieusement ignorée)", async () => {
    vi.mocked(loadJobDoc).mockResolvedValue(null as never);
    const report = await analyzeRenderedMaster({
      masterFile: "/tmp/master.mp4",
      tmpDir: "/tmp",
      plan: fakePlan([{ sceneId: "s1" }]),
      expectedDurationSec: 5,
      subtitlesEnabled: false,
    });
    expect(report.issues.filter((i) => i.kind === "missing_asset")).toHaveLength(0);
  });

  it("la lecture projet qui échoue n'échoue JAMAIS le QC (best-effort)", async () => {
    vi.mocked(loadJobDoc).mockRejectedValue(new Error("Firestore indisponible"));
    const report = await analyzeRenderedMaster({
      masterFile: "/tmp/master.mp4",
      tmpDir: "/tmp",
      plan: fakePlan([{ sceneId: "s1" }]),
      expectedDurationSec: 5,
      subtitlesEnabled: false,
    });
    expect(report.issues.filter((i) => i.kind === "missing_asset")).toHaveLength(0);
    expect(report.checkedAt).toBeTruthy();
  });
});
