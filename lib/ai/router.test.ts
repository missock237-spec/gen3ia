import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AIRequest } from "./models";

// Les PROVIDERS sont figes au chargement du module selon les variables
// d'environnement : on pose les cles avant l'import dynamique.
beforeAll(() => {
  process.env.GROQ_API_KEY = "test-groq";
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.OPENROUTER_API_KEY = "test-openrouter";
});

const loadRouter = async () => await import("./router");

function request(overrides: Partial<AIRequest>): AIRequest {
  return { task: "chat", messages: [{ role: "user", content: "Bonjour" }], ...overrides };
}

describe("selectProvider", () => {
  it("renvoie uniquement des fournisseurs actifs capables de servir la tache", async () => {
    const { selectProvider } = await loadRouter();
    const decisions = selectProvider(request({}));
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      expect(decision.model).toBeTruthy();
      expect(decision.model).not.toBe("auto");
      expect(decision.score).not.toBe(-Infinity);
    }
  });

  it("trie les decisions par score decroissant", async () => {
    const { selectProvider } = await loadRouter();
    const decisions = selectProvider(request({}));
    for (let i = 1; i < decisions.length; i++) {
      expect(decisions[i - 1].score).toBeGreaterThanOrEqual(decisions[i].score);
    }
  });

  it("bonus de +100 au score quand le fournisseur est prefere explicitement", async () => {
    const { selectProvider } = await loadRouter();
    const baseline = selectProvider(request({}));
    const winner = baseline[0];
    expect(winner).toBeDefined();
    const preferred = selectProvider(request({ provider: winner.provider as AIRequest["provider"] }));
    const preferredWinner = preferred.find((d) => d.provider === winner.provider);
    expect(preferredWinner).toBeDefined();
    expect(preferredWinner!.score).toBe(winner.score + 100);
  });

  it("reste vide quand aucune cle fournisseur n'est configuree", async () => {
    const saved = { groq: process.env.GROQ_API_KEY, openai: process.env.OPENAI_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
    // Recharge le module sans cles : le registre PROVIDERS devient inactif.
    vi.resetModules();
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const fresh = await import("./router");
      expect(fresh.selectProvider(request({}))).toHaveLength(0);
      expect(fresh.selectModel(request({}))).toBeNull();
    } finally {
      process.env.GROQ_API_KEY = saved.groq;
      process.env.OPENAI_API_KEY = saved.openai;
      process.env.OPENROUTER_API_KEY = saved.openrouter;
      vi.resetModules();
    }
  });
});

describe("selectModel", () => {
  it("renvoie la meilleure decision unique", async () => {
    const { selectModel } = await loadRouter();
    const decision = selectModel(request({}));
    expect(decision).not.toBeNull();
    expect(typeof decision?.provider).toBe("string");
    expect(typeof decision?.score).toBe("number");
  });

  it("echoue explicitement quand aucun fournisseur configure ne peut executer la tache", async () => {
    vi.resetModules();
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.HF_TOKEN;
    try {
      const fresh = await import("./router");
      await expect(fresh.generate(request({}))).rejects.toThrow(/No configured provider/i);
    } finally {
      process.env.GROQ_API_KEY = "test-groq";
      process.env.OPENAI_API_KEY = "test-openai";
      process.env.OPENROUTER_API_KEY = "test-openrouter";
      vi.resetModules();
    }
  });

  it("ne propose jamais un modele incapable de servir la tache demandee", async () => {
    const { selectProvider, MODEL_CAPABILITIES } = await loadRouter();
    const decisions = selectProvider(request({ task: "video" }));
    for (const decision of decisions) {
      const capability = MODEL_CAPABILITIES.find(
        (item: { provider: string; model: string; tasks: string[] }) =>
          item.provider === decision.provider && item.model === decision.model,
      );
      expect(capability?.tasks).toContain("video");
    }
  });
});
