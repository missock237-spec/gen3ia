import { describe, expect, it } from "vitest";

import { dureeDuTexte, voiceSpeakTool } from "./voice-speak";

/**
 * VOICE.SPEAK RÉEL (audit multimodal) : l'outil était PROMIS par l'AUDIO
 * RULE mais aucun exécuteur n'existait — toute étape planifiée échouait
 * « Unknown tool ». Verrous structurels :
 *  1. l'outil est bien identifié « voice.speak », risque low (pas
 *     d'approbation — capacité interne de la plateforme) ;
 *  2. la durée dérivée du texte est bornée 4–30 s ;
 *  3. le schéma exige un texte non vide ;
 *  4. la description est HONNÊTE (composition neuronale, pas parole
 *     naturelle) — aucun mensonge au planificateur.
 */

describe("voice.speak — outil de synthèse audio locale", () => {
  it("est identifié voice.speak, catégorie media, risque low", () => {
    expect(voiceSpeakTool.id).toBe("voice.speak");
    expect(voiceSpeakTool.name).toBe("voice.speak");
    expect(voiceSpeakTool.category).toBe("media");
    expect(voiceSpeakTool.risk).toBe("low");
  });

  it("annonce honnêtement la nature du rendu (pas de parole naturelle)", () => {
    expect(voiceSpeakTool.description.toLowerCase()).toContain("pas de la parole naturelle");
  });

  it("dureeDuTexte : dérivée du nombre de mots, bornée 4–30 s", () => {
    expect(dureeDuTexte("Bonjour")).toBe(6);
    expect(dureeDuTexte("un deux trois quatre cinq six sept huit neuf dix")).toBe(5);
    expect(dureeDuTexte(Array.from({ length: 200 }, () => "mot").join(" "))).toBe(30);
    expect(dureeDuTexte("   ")).toBe(6); // 0 mot → repli 6 s
  });

  it("le schéma refuse un texte vide ou hors bornes", () => {
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "" })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "x".repeat(4001) })).toThrow();
    expect(() => voiceSpeakTool.inputSchema.parse({ text: "Salut", dureeSecondes: 45 })).toThrow();
    const valide = voiceSpeakTool.inputSchema.parse({ text: "Salut la plateforme" });
    expect(valide.text).toBe("Salut la plateforme");
  });
});
