import { describe, expect, it } from "vitest";

import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { deliverablesSection, extractDeliverables } from "./deliverables";

function planWith(steps: Array<Record<string, unknown>>): RuntimePlan {
  return {
    executionId: "exec-1",
    objective: "objectif",
    steps: steps.map((step) => ({
      id: "s1",
      type: "tool",
      name: "Étape",
      description: "Étape",
      dependencies: [],
      status: "pending",
      input: {},
      skillIds: [],
      maxRetries: 2,
      timeoutMs: 120_000,
      sideEffect: false,
      requiresApproval: false,
      ...step,
    })) as RuntimePlan["steps"],
    maxConcurrency: 1,
    maxIterations: 5,
  };
}

/**
 * MANIFEST DE LIVRABLES (exigence production « système mission avancé ») :
 * les livrables sont extraits des sorties RÉELLES — jamais inventés.
 */
describe("extractDeliverables", () => {
  it("extrait un artefact persisté (artifact.create complété)", () => {
    const plan = planWith([
      { id: "a1", toolName: "artifact.create", status: "completed" },
      { id: "a2", toolName: "artifact.create", status: "pending" },
    ]);
    const outputs = {
      a1: { success: true, artifactId: "art-1", filename: "rapport.pdf", format: "pdf", sizeBytes: 2048, storageKey: "users/u/artifacts/rapport.pdf" },
      a2: { artifactId: "art-2" },
    };
    const deliverables = extractDeliverables(plan, outputs);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]).toMatchObject({
      kind: "artifact",
      artifactId: "art-1",
      filename: "rapport.pdf",
      format: "pdf",
    });
  });

  it("ignore les étapes en échec (jamais de faux livrable)", () => {
    const plan = planWith([{ id: "a1", toolName: "artifact.create", status: "failed" }]);
    const deliverables = extractDeliverables(plan, { a1: { artifactId: "art-1", filename: "x.pdf" } });
    expect(deliverables).toHaveLength(0);
  });

  it("extrait un zip et un fichier de workspace", () => {
    const plan = planWith([
      { id: "z1", toolName: "zip.create", status: "completed" },
      { id: "f1", toolName: "file.create", status: "completed" },
    ]);
    const outputs = {
      z1: { success: true, filename: "archive.zip", sizeBytes: 1024, storageKey: "artifacts/archive.zip" },
      f1: { success: true, filename: "notes.md", sizeBytes: 200 },
    };
    const deliverables = extractDeliverables(plan, outputs);
    expect(deliverables.map((item) => item.kind).sort()).toEqual(["file", "zip"]);
  });

  it("retourne une liste vide sans sortie réelle", () => {
    expect(extractDeliverables(planWith([{ id: "a1", toolName: "artifact.create", status: "completed" }]), {})).toHaveLength(0);
  });

  it("la section livrables est vide sans livrable et liste les fichiers sinon", () => {
    expect(deliverablesSection([])).toBe("");
    const section = deliverablesSection([{ stepId: "a1", name: "Rapport", kind: "artifact", filename: "rapport.pdf", format: "pdf", sizeBytes: 2048 }]);
    expect(section).toContain("Rapport");
    expect(section).toContain("rapport.pdf");
    expect(section).toContain("PDF");
  });

  it("extrait une vidéo produite (video.create → job + projet studio)", () => {
    const plan = planWith([{ id: "v1", toolName: "video.create", status: "completed", name: "Pub produit", description: "Vidéo publicitaire produit" }]);
    const deliverables = extractDeliverables(plan, { v1: { success: true, jobId: "job-9", projectId: "proj-7", studioUrl: "/studio/video/proj-7" } });
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]).toMatchObject({
      kind: "video",
      artifactId: "job-9",
      filename: "video-job-9",
      storageKey: "proj-7",
      name: "Vidéo publicitaire produit",
    });
    const section = deliverablesSection(deliverables);
    expect(section).toContain("[Vidéo - à ouvrir dans le studio]");
    expect(section).toContain("/studio/video/proj-7");
  });

  it("extrait un audio de voix-off persisté (voice.speak storage r2 → clé R2)", () => {
    const plan = planWith([{ id: "s7", toolName: "voice.speak", status: "completed", name: "Narration accueil" }]);
    const deliverables = extractDeliverables(plan, {
      s7: { audioDataUri: "data:audio/mpeg;base64,AAA", url: "users/u1/permanent/ai-audio/123-abc.mp3", storage: "r2", mimeType: "audio/mpeg" },
    });
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]).toMatchObject({
      kind: "audio",
      artifactId: "s7",
      storageKey: "users/u1/permanent/ai-audio/123-abc.mp3",
      filename: "audio-s7.mp3",
    });
    const section = deliverablesSection(deliverables);
    expect(section).toContain("[Audio - voix-off]");
    expect(section).toContain("users/u1/permanent/ai-audio/123-abc.mp3");
  });

  it("déduit l'extension audio du mimeType (wav)", () => {
    const plan = planWith([{ id: "s8", toolName: "voice.speak", status: "completed" }]);
    const deliverables = extractDeliverables(plan, {
      s8: { url: "users/u1/permanent/ai-audio/456-def", storage: "r2", mimeType: "audio/wav" },
    });
    expect(deliverables[0]?.filename).toBe("audio-s8.wav");
  });

  it("NE liste PAS un audio inline (storage inline sans clé : jamais de faux livrable)", () => {
    const plan = planWith([{ id: "s9", toolName: "voice.speak", status: "completed" }]);
    const deliverables = extractDeliverables(plan, {
      s9: { audioDataUri: "data:audio/mpeg;base64,AAA", storage: "inline", mimeType: "audio/mpeg" },
    });
    expect(deliverables).toHaveLength(0);
  });

  it("tri : vidéos et audios en PRIORITÉ avant les artefacts (cap 20 ne les évince jamais)", () => {
    const steps = Array.from({ length: 22 }, (_v, i) => ({ id: `a${i}`, toolName: "artifact.create", status: "completed" }));
    steps.push({ id: "vid", toolName: "video.create", status: "completed" });
    steps.push({ id: "voc", toolName: "voice.speak", status: "completed" });
    const plan = planWith(steps);
    const outputs: Record<string, unknown> = {};
    for (let i = 0; i < 22; i += 1) outputs[`a${i}`] = { artifactId: `art-${i}`, filename: `f${i}.pdf` };
    outputs["vid"] = { jobId: "job-v", projectId: "proj-v" };
    outputs["voc"] = { url: "users/u1/permanent/ai-audio/x.mp3", storage: "r2" };
    const deliverables = extractDeliverables(plan, outputs);
    expect(deliverables).toHaveLength(20); // cap conservé
    expect(deliverables[0]?.kind).toBe("video");
    expect(deliverables[1]?.kind).toBe("audio");
  });
});
