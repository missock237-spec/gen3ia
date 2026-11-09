import { describe, expect, it } from "vitest";

import { dureeDuTexte, voiceSpeakTool } from "./voice-speak";
import { VOIX_PROFESSEUR } from "@/lib/neural/professeur-media";

/**
 * VOICE.SPEAK RÉEL (audit multimodal, étendu it.140) : l'outil était PROMIS
 * par l'AUDIO RULE puis rendu réel. it.140 — le mode par défaut est devenu
 * la VOIX HUMAINE RÉELLE (professeur média temporaire, loi
 * CONTRAINTE-ONDES) avec voix au choix et vitesse réglable ; le repli
 * local (composition harmonique) reste honnêtement signalé. Verrous
 * structurels :
 *  1. l'outil est bien identifié « voice.speak », risque low (pas
 *     d'approbation — capacité interne de la plateforme) ;
 *  2. la durée dérivée du texte est bornée 4–30 s ;
 *  3. le schéma exige un texte non vide, voix ∈ roster documenté,
 *     vitesse ∈ [0.5, 2] ;
 *  4. la description est HONNÊTE dans les DEUX sens : elle annonce la voix
 *     humaine réelle via le professeur ET signale le repli local qui
 *     n'est pas de la parole — aucun mensonge au planificateur.
 */

describe("voice.speak — outil de synthèse vocale parlée", () => {
  it("est identifié voice.speak, catégorie media, risque low", () => {
    expect(voiceSpeakTool.id).toBe("voice.speak");
    expect(voiceSpeakTool.name).toBe("voice.speak");
    expect(voiceSpeakTool.category).toBe("media");
    expect(voiceSpeakTool.risk).toBe("low");
  });

  it("annonce honnêtement le MODE VOIX HUMAINE RÉELLE (professeur) et le repli local", () => {
    const bas = voiceSpeakTool.description.toLowerCase();
    // Mode 1 : voix humaine réelle via le professeur média temporaire.
    expect(bas).toContain("voix humaine");
    expect(bas).toContain("professeur");
    // Mode 2 : repli local honnête (composition, pas de la parole).
    expect(bas).toContain("composition harmonique");
    expect(bas).toContain("pas de la parole");
  });

  it("propose exactement le roster documenté du professeur (7 voix)", () => {
    expect([...VOIX_PROFESSEUR]).toEqual([
      "tongtong",
      "chuichui",
      "xiaochen",
      "jam",
      "kazi",
      "douji",
      "luodo",
    ]);
  });

  it("dureeDuTexte : dérivée du nombre de mots, bornée 4–30 s", () => {
    expect(dureeDuTexte("Bonjour")).toBe(6);
    expect(dureeDuTexte("un deux trois quatre cinq six sept huit neuf dix")).toBe(5);
    expect(dureeDuTexte(Array.from({ length: 200 }, () => "mot").join(" "))).toBe(30);
    expect(dureeDuTexte("   ")).toBe(6); // 0 mot → repli 6 s
  });

  it("le schéma refuse un texte vide, une voix hors roster ou une vitesse hors bornes", () => {
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "" })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "x".repeat(4001) })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "Salut", dureeSecondes: 45 })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "Salut", voix: "voix-fantome" })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "Salut", vitesse: 3 })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "Salut", vitesse: 0.2 })).toThrow();
    const valide = voiceSpeakTool.inputSchema.parse({
      text: "Salut la plateforme",
      voix: "chuichui",
      vitesse: 1.2,
    });
    expect(valide.text).toBe("Salut la plateforme");
    expect(valide.voix).toBe("chuichui");
    expect(valide.vitesse).toBe(1.2);
  });
});
