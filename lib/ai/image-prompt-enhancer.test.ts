import { describe, expect, it } from "vitest";

import {
  buildImageEnhancementMessages,
  isSaneEnhancement,
  MAX_ENHANCED_PROMPT_LENGTH,
} from "./image-prompt-enhancer";

describe("buildImageEnhancementMessages", () => {
  it("construit un message système avec les règles anti-dérive et le prompt utilisateur", () => {
    const messages = buildImageEnhancementMessages("un chat noir sur un toit");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("EXACTEMENT le même");
    expect(messages[0].content).toContain("une seule ligne");
    expect(messages[1]).toEqual({ role: "user", content: "un chat noir sur un toit" });
  });
});

describe("isSaneEnhancement", () => {
  const raw = "un renard roux dans une forêt au lever du soleil";

  it("accepte une amélioration fidèle qui enrichit le réalisme", () => {
    const enhanced = "Un renard roux dans une forêt au lever du soleil, lumière dorée rasante, brume légère entre les arbres, profondeur de champ douce, pelage détaillé, photoréalisme";
    expect(isSaneEnhancement(raw, enhanced)).toBe(true);
  });

  it("rejette une amélioration vide", () => {
    expect(isSaneEnhancement(raw, "   ")).toBe(false);
  });

  it("rejette une amélioration qui perd le sujet demandé", () => {
    expect(isSaneEnhancement(raw, "Paysage montagneux majestueux au crépuscule avec un ciel étoilé ultra détaillé")).toBe(false);
  });

  it("rejette une amélioration excessive en longueur", () => {
    expect(isSaneEnhancement(raw, `${raw} ${"détail incroyable ".repeat(200)}`.slice(0, MAX_ENHANCED_PROMPT_LENGTH + 50))).toBe(false);
  });

  it("rejette une réponse multi-paragraphes (le modèle a ignoré la consigne)", () => {
    expect(isSaneEnhancement(raw, `${raw}\n\nVoici le prompt amélioré.`)).toBe(false);
  });

  it("accepte un prompt d'origine très court enrichi sans dérive", () => {
    expect(isSaneEnhancement("un logo de café", "Un logo de café minimaliste, forme circulaire équilibrée, deux tons contrastés, rendu vectoriel net")).toBe(true);
  });
});
