import { describe, expect, it } from "vitest";

import { extractVideoParams, looksLikeVideoRequest } from "./video-intent";

describe("Task 134 — détection déterministe des options vidéo à la création", () => {
  it("détecte les sous-titres demandés et leur style (unicode safe)", () => {
    const params = extractVideoParams("Crée une vidéo de 30 secondes avec des sous-titres karaoké");
    expect(params.subtitlesEnabled).toBe(true);
    expect(params.subtitleStyle).toBe("karaoke_pop");
    expect(params.targetDurationSec).toBe(30);
  });

  it("détecte la coupure explicite des sous-titres", () => {
    const params = extractVideoParams("Fais une vidéo TikTok sans sous-titres");
    expect(params.subtitlesEnabled).toBe(false);
    expect(params.platform).toBe("TikTok");
  });

  it("détecte le style jaune cinéma et la position", () => {
    const jaune = extractVideoParams("une vidéo avec sous-titres jaunes");
    expect(jaune.subtitleStyle).toBe("cinematic_yellow");

    const centre = extractVideoParams("une vidéo avec sous-titres centrés");
    expect(centre.subtitlePosition).toBe("center");

    const haut = extractVideoParams("une vidéo avec sous-titres en haut");
    expect(haut.subtitlePosition).toBe("top");
  });

  it("détecte les presets d'effets d'animation", () => {
    expect(extractVideoParams("crée une vidéo avec des effets dynamiques").effectPreset).toBe("dynamic");
    expect(extractVideoParams("crée une vidéo style CapCut").effectPreset).toBe("capcut");
    expect(extractVideoParams("un montage cinématique de mes vacances").effectPreset).toBe("cinematic");
    expect(extractVideoParams("une vidéo avec des effets discrets").effectPreset).toBe("subtle");
    expect(extractVideoParams("une vidéo sans effets").effectPreset).toBe("none");
  });

  it("détecte la coupure de narration (« sans voix »)", () => {
    expect(extractVideoParams("une vidéo muette de 15 secondes").voiceEnabled).toBe(false);
    expect(extractVideoParams("crée une vidéo sans voix sur mes vacances").voiceEnabled).toBe(false);
  });

  it("combine tous les paramètres d'une demande riche", () => {
    const params = extractVideoParams("Génère une vidéo TikTok de 45 secondes comme CapCut avec sous-titres karaoké");
    expect(params.platform).toBe("TikTok");
    expect(params.aspectRatio).toBe("9:16");
    expect(params.targetDurationSec).toBe(45);
    expect(params.effectPreset).toBe("capcut");
    expect(params.subtitleStyle).toBe("karaoke_pop");
    expect(params.derivedTargets).toContain("tiktok_9_16");
  });

  it("ne déclenche pas de faux positifs sur une demande neutre", () => {
    const params = extractVideoParams("Crée une vidéo sur l'histoire de Paris");
    expect(params.subtitlesEnabled).toBeUndefined();
    expect(params.subtitleStyle).toBeUndefined();
    expect(params.effectPreset).toBeUndefined();
    expect(params.voiceEnabled).toBeUndefined();
  });

  it("les demandes vidéo restent détectées (non-régression looksLikeVideoRequest)", () => {
    expect(looksLikeVideoRequest("Crée une vidéo de 5s d'un bébé qui marche")).toBe(true);
    expect(looksLikeVideoRequest("Comment créer une bonne vidéo ?")).toBe(false);
  });
});
