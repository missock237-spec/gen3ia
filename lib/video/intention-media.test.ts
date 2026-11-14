import { describe, expect, it } from "vitest";
import { demandePlanFixe, demandeSousTitres } from "./intention-media";

/**
 * Garde de la demande propriétaire 2026-11-14 : les sous-titres ne sont
 * ajoutés QUE sur demande explicite de l'utilisateur ; un plan fixe
 * explicitement demandé est le seul cas de scène immobile.
 */
describe("intention-media — sous-titres sur demande explicite", () => {
  it("une demande explicite FR est reconnue (accents, casse, tirets)", () => {
    expect(demandeSousTitres("Crée une vidéo sur les pandas avec des sous-titres")).toBe(true);
    expect(demandeSousTitres("Ajoute des sous titres lisibles")).toBe(true);
    expect(demandeSousTitres("SOUS-TITRÉS obligatoires pour TikTok")).toBe(true);
    expect(demandeSousTitres("mets des légendes à l'écran")).toBe(true);
    expect(demandeSousTitres("je veux le texte à l'écran")).toBe(true);
    expect(demandeSousTitres("style karaoké mot à mot")).toBe(true);
  });

  it("une demande explicite EN est reconnue", () => {
    expect(demandeSousTitres("make a video about volcanoes with subtitles")).toBe(true);
    expect(demandeSousTitres("add captions please")).toBe(true);
  });

  it("un brief NEUTRE ne déclenche JAMAIS les sous-titres (défaut inversé)", () => {
    expect(demandeSousTitres("Crée une vidéo de 30 secondes sur les volcans")).toBe(false);
    expect(demandeSousTitres("vidéo documentaire cinématique avec narration et musique")).toBe(false);
    expect(demandeSousTitres("short vertical pour TikTok, énergique")).toBe(false);
    expect(demandeSousTitres("")).toBe(false);
  });

  it("un REFUS explicite gagne contre tout marqueur (volonté = contrat)", () => {
    expect(demandeSousTitres("vidéo avec sous-titres — non, finalement sans sous-titres")).toBe(false);
    expect(demandeSousTitres("pas de sous-titres malgré la narration")).toBe(false);
    expect(demandeSousTitres("no captions")).toBe(false);
    expect(demandeSousTitres("subtitles off")).toBe(false);
  });
});

describe("intention-media — plan fixe explicite (seule scène immobile admise)", () => {
  it("reconnaît les demandes de caméra immobile", () => {
    expect(demandePlanFixe("vidéo de la tour en plan fixe")).toBe(true);
    expect(demandePlanFixe("caméra immobile sur le paysage")).toBe(true);
    expect(demandePlanFixe("filmé au trépied, no motion")).toBe(true);
    expect(demandePlanFixe("sans zoom sur le visage")).toBe(true);
    expect(demandePlanFixe("fixed shot of the desk")).toBe(true);
  });

  it("un brief ordinaire demande implicitement du mouvement", () => {
    expect(demandePlanFixe("vidéo dynamique avec des zooms et transitions")).toBe(false);
    expect(demandePlanFixe("documentaire cinématique")).toBe(false);
    expect(demandePlanFixe("")).toBe(false);
  });
});
