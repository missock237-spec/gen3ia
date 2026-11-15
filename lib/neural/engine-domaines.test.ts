import { describe, it, expect, afterAll } from "vitest";

import { getNeuralRuntime, resetBrain } from "./runtime";

/**
 * MOTEUR × DOMAINES — le domaine reconnu est rapporté honnêtement dans
 * raw (detection lexicale primaire) et la réponse mentionne le domaine
 * quand le repli décodeur est utilisé.
 */
describe("NeuralEngine — couche des domaines", () => {
  it("raw.domaine rapporte le domaine reconnu avec sa source", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [
        { role: "user", content: "Peux-tu préparer un storyboard pour ma vidéo produit ?" },
      ],
    });

    const raw = reponse.raw as {
      domaine?: { label: string; nom: string; score: number; source: string };
    };
    expect(raw).toBeDefined();
    expect(raw.domaine).toBeDefined();
    expect(raw.domaine!.label).toBe("DOM_VIDEO");
    expect(raw.domaine!.source).toBe("lexical");
    expect(raw.domaine!.score).toBeGreaterThan(0);
  });

  it("aucun domaine inventé pour un prompt sans mot-clé de domaine", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "xyzzy qwerty flurb" }],
    });
    const raw = reponse.raw as { domaine?: unknown };
    expect(raw.domaine).toBeUndefined();
  });

  afterAll(() => {
    resetBrain();
  });
});
