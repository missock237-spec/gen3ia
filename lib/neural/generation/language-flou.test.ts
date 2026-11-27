/**
 * Tests — GÉNÉRALISATION MORPHOLOGIQUE DU CORTEX LANGAGIER (v2.1).
 *
 * Couche post-audit : les tokens de requête inconnus sont rapprochés du
 * vocabulaire indexé par trigrammes (Dice). On vérifie :
 *  - les vecteurs de similarité pure (déterminisme, bornes) ;
 *  - le gain RÉEL : des requêtes hors vocabulaire exact (faute de frappe,
 *    morphologie irrégulière) obtiennent une réponse AVEC la couche floue
 *    et AUCUNE réponse sans — mesure A/B, pas une supposition ;
 *  - l'ABSENCE de régression : requêtes sans rapport restent rejetées,
 *    les nombres ne sont jamais rapprochés, le déterminisme tient.
 */

import { describe, expect, it } from "vitest";

import type { PaireLangage } from "./corpus";
import {
  CortexLangagierGen3,
  POIDS_FLOU,
  SEUIL_TRIGRAMMES,
  similariteTrigrammes,
  trigrammesDe,
} from "./language";

function paire(motif: string, reponse: string, theme = "test-flou"): PaireLangage {
  return { motif, reponse, theme };
}

describe("similarité par trigrammes (pure)", () => {
  it("borne 0..1 et détermine les cas évidents", () => {
    expect(similariteTrigrammes("recette", "recette")).toBe(1);
    expect(similariteTrigrammes("chat", "chien")).toBe(0);
    expect(similariteTrigrammes("bonjour", "bonjor")).toBeGreaterThan(0.6);
    expect(similariteTrigrammes("chateau", "chatel")).toBeGreaterThan(SEUIL_TRIGRAMMES);
    expect(similariteTrigrammes("", "")).toBe(0);
  });

  it("est déterministe et symétrique", () => {
    expect(similariteTrigrammes("montagne", "montagnes")).toBe(
      similariteTrigrammes("montagnes", "montagne"),
    );
    expect(similariteTrigrammes("montagne", "montagnes")).toBeGreaterThan(0.8);
  });

  it("trigrammesDe couvre les tokens courts", () => {
    expect(trigrammesDe("ia")).toEqual(new Set(["ia"]));
    expect(trigrammesDe("abc")).toEqual(new Set(["abc"]));
    expect(trigrammesDe("abcd")).toEqual(new Set(["abc", "bcd"]));
  });
});

describe("rapprochement flou du cortex (A/B mesuré)", () => {
  it("une faute de frappe retrouve la paire apprise — et rien sans la couche floue", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([
      paire("bonjour", "Bonjour ! Comment puis-je t'aider aujourd'hui ?"),
    ]);

    cortex.definirModeFlou(false);
    const sans = cortex.repondre("bonjor, tu es là ?");
    expect(sans).toBeNull();

    cortex.definirModeFlou(true);
    const avec = cortex.repondre("bonjor, tu es là ?");
    expect(avec).not.toBeNull();
    expect(avec!.texte).toContain("Bonjour");
  });

  it("morphologie irrégulière (travail/travaux, vitrail/vitraux) — hors portée de la racinisation", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([
      paire("travail vitrail corail", "Le travail sur vitrail et corail est délicat."),
    ]);

    // Tous les tokens informatifs divergent (travaux→traval, vitraux→vitral,
    // coraux→coraux selon racineLegere) : sans couche floue, aucun recoupement
    // exact → aucun score → aucune réponse.
    cortex.definirModeFlou(false);
    expect(cortex.repondre("les travaux de vitraux et de coraux")).toBeNull();

    cortex.definirModeFlou(true);
    const avec = cortex.repondre("les travaux de vitraux et de coraux");
    expect(avec).not.toBeNull();
    expect(avec!.texte).toContain("corail");
  });

  it("une requête sans rapport reste rejetée (pas de faux positifs)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([
      paire("bonjour", "Bonjour ! Comment puis-je t'aider aujourd'hui ?"),
      paire("recette de tajine", "Le tajine se cuisine avec des pruneaux."),
    ]);

    cortex.definirModeFlou(true);
    expect(cortex.repondre("achat de voitures d'occasion")).toBeNull();
    expect(cortex.repondre("météo demain à paris")).toBeNull();
  });

  it("les nombres purs ne sont jamais rapprochés", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([paire("prix du carton 38", "Le carton coûte 12 francs.")]);

    cortex.definirModeFlou(true);
    expect(cortex.repondre("livraison 39 colis")).toBeNull();
  });

  it("déterminisme : mêmes entrées → même score (deux cortex fraîchement appris)", () => {
    const construire = (): CortexLangagierGen3 => {
      const cortex = new CortexLangagierGen3();
      cortex.apprendre([
        paire("bonjour", "Bonjour ! Comment puis-je t'aider aujourd'hui ?"),
      ]);
      cortex.definirModeFlou(true);
      return cortex;
    };
    const premier = construire().repondre("bonjor !");
    const second = construire().repondre("bonjor !");
    expect(premier).not.toBeNull();
    expect(second).not.toBeNull();
    expect(premier!.score).toBe(second!.score);
    expect(premier!.texte).toBe(second!.texte);
  });

  it("le poids flou est un signe mesurable du score (inférieur à un match exact)", () => {
    expect(POIDS_FLOU).toBeGreaterThan(0);
    expect(POIDS_FLOU).toBeLessThan(1);
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([paire("bonjour", "Bonjour ! Comment puis-je t'aider aujourd'hui ?")]);
    const exacte = cortex.repondre("bonjour");
    const floue = cortex.repondre("bonjor !");
    expect(exacte).not.toBeNull();
    expect(floue).not.toBeNull();
    expect(floue!.score).toBeLessThan(exacte!.score);
  });
});
