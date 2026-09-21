import { describe, expect, it } from "vitest";

import { extractJsonBlock } from "./planner";
import { formatHint, totalDurationSeconds, type VideoScene } from "./types";

describe("extraction JSON du planificateur vidéo", () => {
  it("parse un JSON direct", () => {
    expect(extractJsonBlock('{"title":"A","scenes":[]}')).toEqual({ title: "A", scenes: [] });
  });

  it("parse un JSON dans un bloc de code clôturé", () => {
    const text = 'Voici le storyboard :\n```json\n{"title":"Pub café","scenes":[{"visualPrompt":"grains"}]}\n```';
    expect(extractJsonBlock(text)).toEqual({ title: "Pub café", scenes: [{ visualPrompt: "grains" }] });
  });

  it("récupère l'objet dans du texte parasite", () => {
    expect(extractJsonBlock('réponse : {"title":"X","scenes":[]} — fin')).toEqual({ title: "X", scenes: [] });
  });

  it("retourne null si aucun JSON exploitable", () => {
    expect(extractJsonBlock("pas de json ici")).toBeNull();
  });
});

describe("helpers vidéo", () => {
  it("formate la consigne de cadrage selon le format cible", () => {
    expect(formatHint("16:9")).toContain("16:9");
    expect(formatHint("9:16")).toContain("9:16");
    expect(formatHint("1:1")).toContain("1:1");
  });

  it("additionne la durée des scènes", () => {
    const scenes = [
      { id: "a", title: "", durationSeconds: 6, visualPrompt: "x", narration: "", onScreenText: "" },
      { id: "b", title: "", durationSeconds: 9, visualPrompt: "y", narration: "", onScreenText: "" },
    ] satisfies VideoScene[];
    expect(totalDurationSeconds(scenes)).toBe(15);
  });
});
