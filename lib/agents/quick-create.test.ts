import { describe, expect, it } from "vitest";

import {
  buildQuickCreatePayload,
  canSubmitQuickCreate,
  QUICK_CREATE_TYPE_KEYS,
  quickCreateTypeOptions,
} from "./quick-create";

describe("buildQuickCreatePayload", () => {
  it("construit un agent de code avec les compétences et outils du type", () => {
    const payload = buildQuickCreatePayload({ name: "Mon dev", typeKey: "code" });
    expect(payload.name).toBe("Mon dev");
    expect(payload.type).toBe("code");
    expect(payload.typeLabel).toBe("Développement & Code");
    expect(payload.skills.length).toBeGreaterThan(0);
    expect(payload.tools).toContain("code.execute");
    expect(payload.agentMode).toBe("standard");
    expect(payload.voiceEnabled).toBe(false);
    expect(payload.voiceConfig).toBeUndefined();
  });

  it("construit un agent vocal en mode appel avec voiceConfig", () => {
    const payload = buildQuickCreatePayload({ name: "Réceptionniste", typeKey: "voice" });
    expect(payload.agentMode).toBe("call");
    expect(payload.voiceEnabled).toBe(true);
    expect(payload.voiceConfig?.greeting).toContain("Réceptionniste");
    expect(payload.voiceConfig?.language).toBe("fr-FR");
  });

  it("utilise le type personnalisé saisi par l'utilisateur", () => {
    const payload = buildQuickCreatePayload({ name: "Juriste", typeKey: "custom", customType: "Juridique" });
    expect(payload.typeLabel).toBe("Juridique");
    expect(payload.description).toContain("Juridique");
    expect(payload.type).toBe("universal");
    expect(payload.skills).toEqual([]);
  });

  it("transmet le fichier mémoire quand il est fourni", () => {
    const payload = buildQuickCreatePayload({
      name: "Agent doc",
      typeKey: "marketing",
      memoryFile: { path: "u1/f.pdf", name: "f.pdf" },
    });
    expect(payload.memoryFile).toEqual({ path: "u1/f.pdf", name: "f.pdf" });
  });
});

describe("canSubmitQuickCreate", () => {
  it("exige un nom d'au moins 2 caractères", () => {
    expect(canSubmitQuickCreate({ name: "A", typeKey: "code" })).toBe(false);
    expect(canSubmitQuickCreate({ name: "Ab", typeKey: "code" })).toBe(true);
  });

  it("exige un type personnalisé précisé", () => {
    expect(canSubmitQuickCreate({ name: "Agent", typeKey: "custom" })).toBe(false);
    expect(canSubmitQuickCreate({ name: "Agent", typeKey: "custom", customType: "RH" })).toBe(true);
  });

  it("rejette une clé de type inconnue", () => {
    expect(canSubmitQuickCreate({ name: "Agent", typeKey: "hacker" })).toBe(false);
  });
});

describe("quickCreateTypeOptions", () => {
  it("propose les types demandés : code, marketing, enseignement, commercial, vocal, personnalisé", () => {
    const keys = quickCreateTypeOptions().map((option) => option.key);
    expect(keys).toEqual([...QUICK_CREATE_TYPE_KEYS]);
    expect(keys).toContain("teaching");
    expect(keys).toContain("sales");
    expect(keys).toContain("voice");
    expect(keys).toContain("custom");
  });
});
