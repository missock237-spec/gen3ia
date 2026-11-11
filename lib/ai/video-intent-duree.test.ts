import { describe, expect, it } from "vitest";

import { dureeAutomatiqueSelonBesoin, extractTargetDurationSec, extractVideoParams } from "@/lib/ai/video-intent";

/**
 * DEMANDE PROPRIÉTAIRE (2026-11-11) : « gen3 doit pouvoir générer de vidéo
 * et voix ultra réaliste — la durée dépend de la demande de l'utilisateur
 * ou du besoin de l'utilisateur en cas où l'utilisateur ne précise pas la
 * durée. » Verrou déterministe (zéro LLM, zéro variance).
 */
describe("dureeAutomatiqueSelonBesoin — durée lue dans le BESOIN (sans durée explicite)", () => {
  it("LA demande de référence (poulet frit + eau pétillante) → clip court", () => {
    const brief = "Crée une vidéo : un homme qui mange du poulet frit et dit qu'il a besoin d'une eau pétillante pour accompagner ce poulet";
    expect(dureeAutomatiqueSelonBesoin(brief)).toBe(15);
  });

  it("chaque séquence décrite rallonge le besoin (+6 s par marqueur)", () => {
    const brief = "Fais une vidéo d'un café : d'abord les grains, puis la mouture, ensuite l'extraction, enfin la dégustation";
    // 4 marqueurs (d'abord, puis, ensuite, enfin) → 15 + 24 = 39 s.
    expect(dureeAutomatiqueSelonBesoin(brief)).toBe(39);
  });

  it("format long explicite (documentaire, tutoriel…) → 60 s, 90 s si « long »", () => {
    expect(dureeAutomatiqueSelonBesoin("Crée un documentaire sur Paris")).toBe(60);
    expect(dureeAutomatiqueSelonBesoin("Crée un tutoriel long et détaillé sur Excel")).toBe(90);
    expect(dureeAutomatiqueSelonBesoin("monte-moi une bande-annonce de mon histoire")).toBe(60);
  });

  it("bornes : plancher 10 s, plafond 180 s", () => {
    expect(dureeAutomatiqueSelonBesoin("une vidéo")).toBe(15);
    // 44 phrases de plus de 12 caractères → 15 + 4×43 = 187 → plafond 180 s.
    const phrases = Array.from({ length: 44 }, (_, i) => `Scène numéro ${i + 1} décrit un moment vraiment distinctif`).join(". ");
    expect(dureeAutomatiqueSelonBesoin(phrases)).toBe(180);
  });

  it("une durée EXPLICITE reste maîtresse (extraction inchangée, l'automatique ne s'applique que sans durée)", () => {
    expect(extractTargetDurationSec("crée une vidéo de 2 minutes sur le café")).toBe(120);
    expect(extractTargetDurationSec("vidéo de 30 secondes")).toBe(30);
    expect(extractVideoParams("crée une vidéo de 45s")).toMatchObject({ targetDurationSec: 45 });
  });
});
