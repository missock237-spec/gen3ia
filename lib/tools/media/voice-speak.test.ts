import { describe, expect, it } from "vitest";

import {
  dureeDuTexte,
  deduireRegistreVoix,
  PROSODIE_PAR_REGISTRE,
  REGISTRES_VOIX,
  voiceSpeakTool,
} from "./voice-speak";
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

describe("voice.speak — registre vocal contextuel (Task 2-a AUDIO)", () => {
  it("annonce la prosodie CONTEXTUELLE (registres) dans la description du tool", () => {
    const description = voiceSpeakTool.description.toLowerCase();
    expect(description).toContain("prosodie contextuelle");
    expect(description).toContain("registre");
    expect(description).toContain("rate/pitch");
  });

  it("détecte les cinq registres documentés depuis le contenu du texte", () => {
    // annonceur (registre du SUPPORT — priorité 1)
    expect(deduireRegistreVoix("Écoutez cette annonce : le lancement commence.").registre).toBe("annonceur");
    expect(deduireRegistreVoix("Une publicité pour notre promotion d'été.").registre).toBe("annonceur");
    // calme (humeur)
    expect(deduireRegistreVoix("Installez-vous… séance de méditation guidée.").registre).toBe("calme");
    expect(deduireRegistreVoix("Respirez profondément, laissez-vous aller vers le sommeil.").registre).toBe("calme");
    // enthousiaste
    expect(deduireRegistreVoix("Félicitations ! Super travail de toute l'équipe.").registre).toBe("enthousiaste");
    // narration (forme)
    expect(deduireRegistreVoix("Il était une fois… voici le premier chapitre de cette histoire.").registre).toBe("narration");
    expect(deduireRegistreVoix("Documentaire sur les légendes bretonnes.").registre).toBe("narration");
    // professionnel (défaut)
    expect(deduireRegistreVoix("Voici le rapport technique du trimestre, avec le résumé des points clés.").registre).toBe("professionnel");
    expect(deduireRegistreVoix("").registre).toBe("professionnel");
  });

  it("la correspondance registre → prosodie Edge-TTS est bornée par les sliders", () => {
    expect([...REGISTRES_VOIX]).toEqual([
      "annonceur",
      "calme",
      "enthousiaste",
      "narration",
      "professionnel",
    ]);
    for (const registre of REGISTRES_VOIX) {
      const p = PROSODIE_PAR_REGISTRE[registre];
      expect(p.ratePourcent).toBeGreaterThanOrEqual(-50);
      expect(p.ratePourcent).toBeLessThanOrEqual(50);
      expect(p.pitchHz).toBeGreaterThanOrEqual(-50);
      expect(p.pitchHz).toBeLessThanOrEqual(50);
      expect(p.vitesse).toBeGreaterThanOrEqual(0.5);
      expect(p.vitesse).toBeLessThanOrEqual(1.5);
      expect(p.quand.length).toBeGreaterThan(10); // documentation lisible
    }
  });

  it("valeurs documentées : calme −22 %/−3 Hz, enthousiaste +15 %/+5 Hz, neutre 0/0", () => {
    expect(PROSODIE_PAR_REGISTRE.calme.ratePourcent).toBe(-22);
    expect(PROSODIE_PAR_REGISTRE.calme.pitchHz).toBe(-3);
    expect(PROSODIE_PAR_REGISTRE.enthousiaste.ratePourcent).toBe(15);
    expect(PROSODIE_PAR_REGISTRE.enthousiaste.pitchHz).toBe(5);
    expect(PROSODIE_PAR_REGISTRE.professionnel.ratePourcent).toBe(0);
    expect(PROSODIE_PAR_REGISTRE.professionnel.pitchHz).toBe(0);
    expect(PROSODIE_PAR_REGISTRE.narration.vitesse).toBeCloseTo(0.92, 5);
    expect(PROSODIE_PAR_REGISTRE.annonceur.vitesse).toBeCloseTo(1.08, 5);
  });

  it("priorité déterministe : l'annonceur gagne sur l'humeur du texte", () => {
    // « annonce » (support) précède « calme » (humeur) dans l'ordre de détection.
    expect(deduireRegistreVoix("Annonce calmement récitée pour le nouveau produit.").registre).toBe("annonceur");
    // Même appel, même résultat — déduction déterministe (zéro LLM).
    const texte = "Séance de relaxation guidée.";
    expect(deduireRegistreVoix(texte)).toEqual(deduireRegistreVoix(texte));
  });

  it("le schéma accepte un registre imposé du roster et refuse les autres", () => {
    const impose = voiceSpeakTool.inputSchema.parse({ text: "Bonjour", registre: "calme" });
    expect(impose.registre).toBe("calme");
    expect(() =>
      voiceSpeakTool.inputSchema.parse({ text: "Bonjour", registre: "chuchotement" }),
    ).toThrow();
  });
});
