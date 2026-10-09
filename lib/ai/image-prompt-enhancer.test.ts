import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 114-b : le LLM et le jumeau sont mockés pour les tests asynchrones
// (les fonctions pures restent testées sans mock).
vi.mock("@/lib/ai/router", () => ({ generate: vi.fn() }));

const twinImageHintMock = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock("@/lib/identity/twin", () => ({
  twinImageHintForUser: (...args: unknown[]) => twinImageHintMock(...args),
}));

import { generate } from "@/lib/ai/router";
import {
  buildImageEnhancementMessages,
  enhanceImagePrompt,
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

describe("enhanceImagePrompt — jumeau créatif (Task 114-b)", () => {
  const PROMPT = "un renard roux dans une forêt au lever du soleil";
  const CANDIDATE =
    "Un renard roux dans une forêt au lever du soleil, lumière dorée rasante, brume légère entre les arbres, profondeur de champ douce, photoréalisme";

  beforeEach(() => {
    vi.mocked(generate).mockReset();
    twinImageHintMock.mockReset();
    twinImageHintMock.mockResolvedValue(undefined);
  });

  it("avec userId : l'extrait du jumeau est ajouté au prompt final", async () => {
    twinImageHintMock.mockResolvedValueOnce("Style : photographie argentique ; Ambiance : chaleureux");
    vi.mocked(generate).mockResolvedValueOnce({ text: CANDIDATE } as never);

    const result = await enhanceImagePrompt(PROMPT, { userId: "user-1" });
    expect(twinImageHintMock).toHaveBeenCalledWith("user-1");
    expect(result.enhanced).toBe(true);
    expect(result.prompt).toContain(CANDIDATE);
    expect(result.prompt).toContain("Style : photographie argentique");
  });

  it("twinHint explicite prioritaire sur la résolution par userId", async () => {
    vi.mocked(generate).mockResolvedValueOnce({ text: CANDIDATE } as never);

    const result = await enhanceImagePrompt(PROMPT, { twinHint: "Ambiance : minimaliste", userId: "user-1" });
    expect(twinImageHintMock).not.toHaveBeenCalled();
    expect(result.prompt).toContain("Ambiance : minimaliste");
  });

  it("sans jumeau (profil vide) : prompt identique au comportement historique", async () => {
    vi.mocked(generate).mockResolvedValueOnce({ text: CANDIDATE } as never);

    const result = await enhanceImagePrompt(PROMPT, { userId: "user-1" });
    expect(result.prompt).toBe(CANDIDATE);
  });

  it("échec LLM : le prompt d'origine porte QUAND MÊME la signature du jumeau", async () => {
    twinImageHintMock.mockResolvedValueOnce("Ambiance : chaleureux");
    vi.mocked(generate).mockRejectedValueOnce(new Error("provider down"));

    const result = await enhanceImagePrompt(PROMPT, { userId: "user-1" });
    expect(result.enhanced).toBe(false);
    expect(result.prompt).toContain(PROMPT);
    expect(result.prompt).toContain("Ambiance : chaleureux");
  });

  it("une panne du module jumeau n'interrompt JAMAIS la génération (fail-soft)", async () => {
    twinImageHintMock.mockRejectedValueOnce(new Error("R2 indisponible"));
    vi.mocked(generate).mockResolvedValueOnce({ text: CANDIDATE } as never);

    const result = await enhanceImagePrompt(PROMPT, { userId: "user-1" });
    expect(result.prompt).toBe(CANDIDATE);
  });
});
