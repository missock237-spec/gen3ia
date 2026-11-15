import { describe, expect, it } from "vitest";

import { blocNegatifVeo3, DIRECTIVES_RENDU_VEO3, planDeTournageVeo3 } from "@/lib/video/veo3-realisme";
import type { ScriptScene, VideoProject } from "@/lib/video/types";

function scene(index: number, overrides: Partial<ScriptScene> = {}): ScriptScene {
  return {
    id: `scene-${index}`,
    chapterId: "ch-1",
    index,
    durationSec: 8,
    narration: "La caméra avance lentement.",
    visualPrompt: "a young engineer walking through a neon-lit workshop",
    visualType: "image",
    subject: "person",
    cameraMotion: "slow_zoom",
    transitionIn: "crossfade",
    transitionOut: "crossfade",
    soundEffects: [],
    captions: false,
    startSec: index * 8,
    ...overrides,
  };
}

function project(overrides: Partial<VideoProject> = {}): VideoProject {
  return {
    id: "proj-1",
    userId: "user-1",
    title: "Documentaire atelier",
    brief: "Un atelier néon",
    prompt: "Un atelier néon",
    aspectRatio: "16:9",
    resolution: "1080p",
    targetDurationSec: 60,
    language: "fr",
    style: "documentaire cinématographique",
    platform: "youtube",
    status: "scripted",
    script: {
      title: "Documentaire atelier",
      introduction: "Intro",
      chapters: [],
      scenes: [],
      conclusion: "Fin",
      estimatedDurationSec: 60,
    },
    visualBible: {
      styleDescriptors: "photorealistic, documentary",
      palette: "teal and warm amber",
      characters: [],
      locations: [],
      negativePrompt: "pas de logo visible",
    },
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  } as unknown as VideoProject;
}

describe("planDeTournageVeo3 — feuille de service par scène", () => {
  it("produit un plan complet et déterministe (même scène → même plan)", () => {
    const p = project();
    const a = planDeTournageVeo3(p, scene(3));
    const b = planDeTournageVeo3(p, scene(3));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tailleDePlan.length).toBeGreaterThan(3);
    expect(a.mouvementCamera).toContain("dolly push-in");
    expect(a.optique).toMatch(/mm/);
    expect(a.lumiere).toMatch(/light|sun|neon/i);
    expect(a.ambiance.length).toBeGreaterThan(10);
    expect(a.designSonore).toContain("ambient");
  });

  it("varie le plan avec l'index et le sujet (équipe qui tourne plusieurs plans)", () => {
    const p = project();
    const plans = [0, 1, 2, 3, 4].map((i) => planDeTournageVeo3(p, scene(i)));
    const lumieres = new Set(plans.map((x) => x.lumiere));
    expect(lumieres.size).toBeGreaterThan(1);
    const personne = planDeTournageVeo3(p, scene(0, { subject: "person" }));
    const lieu = planDeTournageVeo3(p, scene(0, { subject: "place" }));
    expect(personne.tailleDePlan).not.toBe(lieu.tailleDePlan);
  });

  it("adapte le design sonore aux effets déclarés", () => {
    const p = project();
    const avecEffets = planDeTournageVeo3(p, scene(1, { soundEffects: ["wind", "footsteps"] }));
    expect(avecEffets.designSonore).toContain("wind");
    expect(avecEffets.designSonore).toContain("footsteps");
  });
});

describe("blocNegatifVeo3 — le socle anti-« fausse vidéo »", () => {
  it("interdit explicitement les artefacts Veo 3 connus, même sans bible", () => {
    const bloc = blocNegatifVeo3();
    expect(bloc).toContain("no morphing");
    expect(bloc).toContain("no flicker");
    expect(bloc).toContain("anatomically correct");
    expect(bloc).toContain("watermark or logo");
  });

  it("enrichit le socle avec la bible visuelle sans jamais la remplacer", () => {
    const bloc = blocNegatifVeo3("pas de logo visible");
    expect(bloc).toContain("pas de logo visible");
    expect(bloc).toContain("no morphing");
  });
});

describe("DIRECTIVES_RENDU_VEO3 — le rendu interne n'est pas un diaporama", () => {
  it("borne le zoom par seconde (au-delà = effet Ken Burns agressif)", () => {
    expect(DIRECTIVES_RENDU_VEO3.zoomParSecondeMax).toBeLessThanOrEqual(0.04);
    expect(DIRECTIVES_RENDU_VEO3.easing).toBe("smoothstep");
    expect(DIRECTIVES_RENDU_VEO3.determinisme).toContain("same render");
  });
});
