import { describe, expect, it } from "vitest";

import {
  bornerDuree,
  extraireDureeSecondes,
  idsStylesMusique,
  parseStyleMusique,
  styleParId,
} from "./styles";

/**
 * ANALYSE DE DEMANDE MUSICALE (Task 2-a AUDIO) — le style/la durée/ l'humeur
 * doivent être EN RAPPORT avec la demande utilisateur en français naturel.
 * Verrous :
 *  1. durées « 2 min », « 90 secondes », « 1 min 30 », « une heure », en
 *     toutes lettres — détectées puis bornées 30..300 s ;
 *  2. styles détectés par mots-clés (lofi, acoustique/piano, jazz, ambient…) ;
 *  3. humeur modulante (calme → tempo réduit, mode) et tempo explicite
 *     (« 120 bpm ») qui GAGNE toujours ;
 *  4. déterminisme strict : même demande → même objet analysé.
 */

describe("extraireDureeSecondes — durées en français naturel", () => {
  it("détecte « 2 min » (scénario propriétaire) → 120 s", () => {
    expect(extraireDureeSecondes("crée une musique de 2 min")).toBe(120);
    expect(extraireDureeSecondes("une musique de 2 minutes")).toBe(120);
    expect(extraireDureeSecondes("musique 3min")).toBe(180);
  });

  it("détecte les secondes seules (« 90 secondes », « 90 s », « 120s »)", () => {
    expect(extraireDureeSecondes("une intro de 90 secondes")).toBe(90);
    expect(extraireDureeSecondes("90 s de musique")).toBe(90);
    expect(extraireDureeSecondes("boucle 120s")).toBe(120);
  });

  it("détecte le format combiné « 1 min 30 » → 90 s", () => {
    expect(extraireDureeSecondes("un jingle de 1 min 30")).toBe(90);
    expect(extraireDureeSecondes("2 minutes et 30 secondes")).toBe(150);
  });

  it("détecte les mots français (« une minute et demie », « deux minutes »)", () => {
    expect(extraireDureeSecondes("une minute et demie de suspense")).toBe(90);
    expect(extraireDureeSecondes("deux minutes de calme")).toBe(120);
  });

  it("heures et demi-heures (bornées ensuite par bornerDuree)", () => {
    expect(extraireDureeSecondes("une heure de concentration")).toBe(3600);
    expect(extraireDureeSecondes("une demi-heure de lofi")).toBe(180);
    expect(bornerDuree(3600)).toBe(300);
  });

  it("retourne null quand aucune durée n'est citée", () => {
    expect(extraireDureeSecondes("crée une musique au piano")).toBeNull();
    expect(extraireDureeSecondes("")).toBeNull();
  });

  it("bornerDuree : bornes 30..300 s, défaut 120 s sur entrée absurde", () => {
    expect(bornerDuree(10)).toBe(30);
    expect(bornerDuree(900)).toBe(300);
    expect(bornerDuree(Number.NaN)).toBe(120);
    expect(bornerDuree(121.7)).toBe(122);
  });
});

describe("parseStyleMusique — style, humeur, tempo, instruments", () => {
  it("« une musique calme de 2 minutes au piano » → acoustique/piano, 120 s, humeur calme", () => {
    const p = parseStyleMusique("une musique calme de 2 minutes au piano");
    expect(p.style.id).toBe("acoustique");
    expect(p.style.timbreMelodie).toBe("piano");
    expect(p.style.timbreHarmonie).toBe("piano");
    expect(p.humeur).toBe("calme");
    expect(p.dureeDetectee).toBe(true);
    expect(p.dureeSecondes).toBe(120);
    // Le tempo est modulé par l'humeur calme (facteur 0.92) puis borné.
    expect(p.tempoBpm).toBe(Math.round(96 * 0.92));
    expect(p.styleDemande).toBe(true);
  });

  it("« crée une musique de 2 min » sans style → défaut pop, 120 s", () => {
    const p = parseStyleMusique("crée une musique de 2 min");
    expect(p.style.id).toBe("pop");
    expect(p.styleDemande).toBe(false);
    expect(p.humeur).toBe("neutre");
    expect(p.dureeSecondes).toBe(120);
  });

  it("style lofi détecté avec ses signatures (swing, accords 7ᵉ)", () => {
    const p = parseStyleMusique("un beat lofi chill pour étudier");
    expect(p.style.id).toBe("lofi");
    expect(p.style.accordsSeptieme).toBe(true);
    expect(p.style.swing).toBeGreaterThan(0);
    expect(p.style.percussion).not.toBe("aucune");
  });

  it("mots-clés des autres styles du catalogue", () => {
    expect(parseStyleMusique("musique jazz swing").style.id).toBe("jazz");
    expect(parseStyleMusique("nappe ambient pour dormir").style.id).toBe("ambient");
    expect(parseStyleMusique("une techno danse").style.id).toBe("electronique");
    expect(parseStyleMusique("bande originale épique de film").style.id).toBe("cinematique");
    expect(parseStyleMusique("guitare acoustique folk").style.id).toBe("acoustique");
    expect(parseStyleMusique("du rock puissant").style.id).toBe("rock");
    expect(parseStyleMusique("symphonie classique").style.id).toBe("classique");
    expect(parseStyleMusique("un hit pop").style.id).toBe("pop");
  });

  it("humeur modulante : « pour dormir » → intensité minimale et tempo réduit", () => {
    const p = parseStyleMusique("musique douce pour sommeil");
    expect(p.humeur).toBe("sommeil");
    expect(p.style.intensite).toBeLessThanOrEqual(0.2);
    expect(p.tempoBpm).toBeLessThan(100);
  });

  it("humeur dramatique → mode mineur imposé", () => {
    const p = parseStyleMusique("musique de tension dramatique");
    expect(p.humeur).toBe("dramatique");
    expect(p.style.mode).toBe("mineur");
  });

  it("tempo explicite « 120 bpm » gagne TOUJOURS sur l'humeur", () => {
    const p = parseStyleMusique("musique calme à 120 bpm");
    expect(p.tempoBpm).toBe(120);
  });

  it("instruments cités redirigent les timbres (guitare → harmonie guitare)", () => {
    const p = parseStyleMusique("musique à la guitare");
    expect(p.instruments).toContain("guitare");
    expect(p.style.timbreMelodie).toBe("guitare");
    expect(p.style.timbreHarmonie).toBe("guitare");
  });

  it("durée hors bornes → bornée et brute conservée (honnêteté)", () => {
    const p = parseStyleMusique("musique de 10 secondes");
    expect(p.dureeSecondes).toBe(30);
    expect(p.dureeDemandeeBrute).toBe(10);
    const p2 = parseStyleMusique("musique de 9 minutes");
    expect(p2.dureeSecondes).toBe(300);
    expect(p2.dureeDemandeeBrute).toBe(540);
  });

  it("déterministe : même demande → même objet analysé", () => {
    expect(parseStyleMusique("une musique calme de 2 minutes au piano")).toEqual(
      parseStyleMusique("UNE MUSIQUE CALME DE 2 MINUTES AU PIANO"),
    );
  });
});

describe("catalogue de styles", () => {
  it("couvre les styles demandés par le propriétaire", () => {
    const ids = idsStylesMusique();
    for (const attendu of ["lofi", "pop", "cinematique", "electronique", "acoustique", "jazz", "ambient"]) {
      expect(ids).toContain(attendu);
    }
    expect(ids).toHaveLength(9); // + rock + classique
  });

  it("chaque style a une progression, des timbres valides et un tempo plausible", () => {
    for (const style of idsStylesMusique().map((id) => styleParId(id)!)) {
      expect(style.progressionDegres.length).toBeGreaterThanOrEqual(3);
      expect(style.tempoBpm).toBeGreaterThanOrEqual(40);
      expect(style.tempoBpm).toBeLessThanOrEqual(190);
      expect(style.intensite).toBeGreaterThanOrEqual(0.05);
      expect(style.intensite).toBeLessThanOrEqual(1);
      expect(style.description.length).toBeGreaterThan(10);
    }
  });
});
