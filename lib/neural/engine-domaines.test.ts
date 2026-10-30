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

  it("métabolisme des effecteurs : raw.metabolisme.effecteurs porte le coût réel du corps", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "Bonjour, présente-toi brièvement." }],
    });

    const raw = reponse.raw as {
      metabolisme?: {
        effecteurs?: {
          actions: number;
          actionsMesurees: number;
          coutMesureMs: number;
        } | null;
      };
    };
    expect(raw.metabolisme).toBeDefined();
    // VERROU MÉTABOLISME DU CORPS : le champ est toujours présent (le noyau
    // produit l'instantané à chaque cycle), le coût est 100 % mesuré —
    // actionsMesurees ne peut jamais dépasser actions, et aucun chiffre
    // n'est inventé (0 action → 0 coût).
    expect(raw.metabolisme!.effecteurs).toBeDefined();
    const corps = raw.metabolisme!.effecteurs!;
    expect(corps.actions).toBeGreaterThanOrEqual(0);
    expect(corps.actionsMesurees).toBeLessThanOrEqual(corps.actions);
    expect(corps.coutMesureMs).toBeGreaterThanOrEqual(0);
  });

  afterAll(() => {
    resetBrain();
  });
});
