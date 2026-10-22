import { describe, expect, it } from "vitest";

import {
  analyserScene,
  analyserScenesMultiples,
  construireLexique,
  normaliserMot,
  sceneRendable,
  type LexiqueAppris,
} from "./scene-spec";

/**
 * ANALYSE SÉMANTIQUE DE SCÈNE — verrous :
 *  1. FR/EN : sujets, cadres, moments, météos, styles, ambiances,
 *     couleurs et sons sont reconnus sur des prompts réels ;
 *  2. DÉTERMINISME : le même prompt produit la même spécification ;
 *  3. HONNÊTETÉ : prompt hors vocabulaire → sujet null, couverture
 *     basse, sceneRendable false (le moteur v2 ne se prétend pas
 *     comprendre ce qu'il ne comprend pas) ;
 *  4. CORRESPONDANCE : « château » ≠ « chat » (longest-prefix),
 *     pluriels/dérivés couverts (« chats », « enneigée », « nuageux ») ;
 *  5. LEXIQUE APPRIS : les entrées entraînées hors production étendent
 *     le vocabulaire SANS écraser l'intégré ;
 *  6. STORYBOARD : découpage en scènes multiples (≤ 4).
 */

describe("normaliserMot", () => {
  it("minuscule, sans accent, sans signe hors lettres (tirets conservés)", () => {
    expect(normaliserMot("Château")).toBe("chateau");
    expect(normaliserMot("ÉCOLE")).toBe("ecole");
    expect(normaliserMot("voilier!")).toBe("voilier");
    expect(normaliserMot("apres-midi")).toBe("apres-midi");
  });
});

describe("analyserScene — vocabulaire intégré", () => {
  it("prompt scénique complet : sujet + couleur + cadre + moment", () => {
    const spec = analyserScene("un chat noir au bord de la mer au coucher de soleil");
    expect(spec.sujet?.type).toBe("chat");
    expect(spec.couleurPrincipale).toBe("noir");
    expect(spec.cadre).toBe("ocean");
    expect(spec.moment).toBe("crepuscule");
    expect(sceneRendable(spec)).toBe(true);
  });

  it("anglais : black cat by the sea at sunset", () => {
    const spec = analyserScene("a black cat by the sea at sunset");
    expect(spec.sujet?.type).toBe("chat");
    expect(spec.cadre).toBe("ocean");
    expect(spec.moment).toBe("crepuscule");
  });

  it("météos multiples et styles", () => {
    const spec = analyserScene("une ville futuriste néon sous la pluie et le tonnerre");
    expect(spec.cadre).toBe("ville");
    expect(spec.style).toBe("neon");
    expect(spec.meteo).toContain("pluie");
    expect(spec.meteo).toContain("orage");
  });

  it("ambiance et sons nommés", () => {
    const spec = analyserScene("un chat endormi près de la cheminée, ambiance mélancolique");
    expect(spec.sujet?.type).toBe("chat");
    expect(spec.sons).toContain("feu");
    expect(spec.ambiance).toBe("melancolique");
  });

  it("locutions multi-mots : coucher du soleil, petit matin, noir et blanc", () => {
    expect(analyserScene("un arbre au coucher du soleil").moment).toBe("crepuscule");
    expect(analyserScene("une cloche au petit matin").moment).toBe("aube");
    expect(analyserScene("un visage en noir et blanc").style).toBe("vintage");
  });

  it("longest-prefix : « château » n'est pas un « chat »", () => {
    expect(analyserScene("un château sur la colline").sujet?.type).toBe("chateau");
    expect(analyserScene("un chat sur le toit").sujet?.type).toBe("chat");
  });

  it("pluriels et dérivés couverts (préfixes)", () => {
    expect(analyserScene("des chats dans les nuages").sujet?.type).toBe("chat");
    expect(analyserScene("la montagne enneigée").meteo).toContain("neige");
    expect(analyserScene("un ciel nuageux").meteo).toContain("nuages");
  });

  it("déterminisme : même prompt → même spécification (copies distinctes)", () => {
    const a = analyserScene("un phare dans la tempête au crépuscule");
    const b = analyserScene("un phare dans la tempête au crépuscule");
    expect(a).toEqual(b);
  });
});

describe("analyserScene — honnêteté du repli", () => {
  it("prompt hors vocabulaire : sujet null, couverture basse, non rendable", () => {
    const spec = analyserScene("xyzzy quux florb waldo");
    expect(spec.sujet).toBeNull();
    expect(spec.cadre).toBeNull();
    expect(spec.couverture).toBeLessThan(0.3);
    expect(sceneRendable(spec)).toBe(false);
  });

  it("prompt vide / mots vides seuls : non rendable, aucune invention", () => {
    const spec = analyserScene("une image de");
    expect(sceneRendable(spec)).toBe(false);
    expect(spec.sujet).toBeNull();
  });
});

describe("lexique appris hors production", () => {
  const appris: LexiqueAppris = {
    v: 1,
    entries: [
      { terme: "minou", categorie: "sujet", valeur: "chat" },
      { terme: "clairiere", categorie: "cadre", valeur: "foret" },
      { terme: "pastel", categorie: "style", valeur: "aquarelle" },
    ],
  };

  it("les entrées apprises étendent le vocabulaire", () => {
    const lexique = construireLexique(appris);
    const spec = analyserScene("un minou dans la clairière, style pastel", lexique);
    expect(spec.sujet?.type).toBe("chat");
    expect(spec.cadre).toBe("foret");
    expect(spec.style).toBe("aquarelle");
  });

  it("l'intégré PRIME : une entrée apprise sur un terme déjà connu est ignorée", () => {
    const lexique = construireLexique({
      v: 1,
      entries: [{ terme: "chat", categorie: "sujet", valeur: "chien" }],
    });
    expect(analyserScene("un chat", lexique).sujet?.type).toBe("chat");
  });

  it("entrées invalides (terme court, valeur vide) rejetées sans erreur", () => {
    const lexique = construireLexique({
      v: 1,
      entries: [
        { terme: "a", categorie: "sujet", valeur: "chat" },
        { terme: "valide", categorie: "cadre", valeur: "" },
        { terme: "chien", categorie: "sujet", valeur: "chien" },
      ],
    });
    expect(analyserScene("un chien", lexique).sujet?.type).toBe("chien");
  });

  it("lexique absent → vocabulaire intégré seul", () => {
    const lexique = construireLexique(null);
    expect(analyserScene("un minou", lexique).sujet).toBeNull();
  });
});

describe("analyserScenesMultiples — storyboard", () => {
  it("découpe par phrases et analyse chaque scène", () => {
    const scenes = analyserScenesMultiples("un phare dans la tempête. puis la ville la nuit sous la neige");
    expect(scenes.length).toBe(2);
    expect(scenes[0]?.sujet?.type).toBe("phare");
    expect(scenes[0]?.meteo).toContain("orage");
    expect(scenes[1]?.cadre).toBe("ville");
    expect(scenes[1]?.moment).toBe("nuit");
    expect(scenes[1]?.meteo).toContain("neige");
  });

  it("plafonné à 4 scènes, prompt simple → une seule scène", () => {
    expect(analyserScenesMultiples("un chat noir").length).toBe(1);
    const quatre = analyserScenesMultiples(
      "un chat. un chien. un arbre. un pont. une tour en plus",
    );
    expect(quatre.length).toBe(4);
  });
});
