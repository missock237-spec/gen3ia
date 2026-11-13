import { describe, expect, it } from "vitest";

import { durcirPromptVideo } from "./professeur-media";

/**
 * PROFESSEUR MÉDIA — durcissement du prompt VIDÉO (fonction pure, aucun
 * réseau). Garanties attendues :
 *  - le sujet DEMANDÉ est préservé mot à mot (jamais de réécriture) ;
 *  - les noyaux du rendu réaliste ne s'ajoutent que si le prompt n'en porte
 *    pas déjà (détection casse/accents : photoréaliste, réaliste,
 *    cinématique, cinematic, hd, 4k…) ;
 *  - le résultat est borné à 1500 caractères.
 * Le rendu ultra-réaliste est donc AUTOMATIQUE : l'utilisateur n'a jamais
 * besoin de le demander.
 */

const NOYAUX = [
  "vidéo réaliste",
  "rendu photoréaliste",
  "mouvement de caméra fluide",
  "lumière naturelle",
  "détails nets",
  "haute définition",
] as const;

describe("durcirPromptVideo — réalisme automatique", () => {
  it("préserve le sujet mot à mot et ajoute les noyaux si non-réaliste", () => {
    const sujet = "un chat noir qui court sur les toits au crépuscule";
    const durci = durcirPromptVideo(sujet);

    // Sujet INTACT, en tête de prompt, jamais réécrit.
    expect(durci.startsWith(sujet)).toBe(true);
    // Chaque noyau de rendu réaliste est présent, à la suite du sujet.
    for (const noyau of NOYAUX) {
      expect(durci).toContain(noyau);
    }
    // Composition déterministe complète.
    expect(durci).toBe(`${sujet}, ${NOYAUX.join(", ")}`);
  });

  it("n'ajoute RIEN si le prompt porte déjà un marqueur de réalisme", () => {
    const marqueurs = [
      "une plage au lever du soleil, rendu réaliste",
      "documentaire sur la savane, photoreal",
      "portrait d'un artisan, photograph",
      "la forêt amazonienne en photoréaliste",
      "vol d'aigle en ultra-réaliste",
      "danseuse au miroir, hyperréaliste",
      "la Tour Eiffel au matin cinématique",
      "survol des glaciers, cinematic",
      "aerial drone footage of a canyon, photorealistic",
      "a slow dolly shot in HD",
      "time-lapse of a storm in 4K",
    ];
    for (const prompt of marqueurs) {
      expect(durcirPromptVideo(prompt)).toBe(prompt.trim());
    }
  });

  it("est insensible à la casse et aux accents dans la détection", () => {
    // Casse quelconque ou accents omis : la détection court-circuite quand
    // même l'ajout des noyaux.
    expect(durcirPromptVideo("MONT BLANC EN PHOTORÉALISTE")).toBe("MONT BLANC EN PHOTORÉALISTE");
    expect(durcirPromptVideo("le port de Marseille, cinematique")).toBe("le port de Marseille, cinematique");
    expect(durcirPromptVideo("Réaliste : la rade de Toulon")).toBe("Réaliste : la rade de Toulon");
    expect(durcirPromptVideo("Documentaire 4K sur les coraux")).toBe("Documentaire 4K sur les coraux");
    expect(durcirPromptVideo("Le désert en HD")).toBe("Le désert en HD");
    // « hd » ne se confond pas avec un mot englobant (frontière de mot).
    const durciSansMarqueur = durcirPromptVideo("le hud d'un avion de chasse");
    expect(durciSansMarqueur).toContain("vidéo réaliste");
  });

  it("borne le résultat à 1500 caractères en gardant le sujet en tête", () => {
    const sujet = "l'assemblée des fourmis géantes dans la canopée";
    const remplissage = " décor de jungle luxuriante et brume matinale,".repeat(120);
    const durci = durcirPromptVideo(sujet + remplissage);

    expect(durci.length).toBeLessThanOrEqual(1500);
    expect(durci.startsWith(sujet)).toBe(true);
  });

  it("borne aussi à 1500 un prompt déjà réaliste (sujet intact après troncature)", () => {
    const sujet = "côte sauvage au drone, réaliste";
    const remplissage = " falaises de basalte et mouettes en rafale,".repeat(120);
    const durci = durcirPromptVideo(sujet + remplissage);

    expect(durci.length).toBeLessThanOrEqual(1500);
    expect(durci.startsWith(sujet)).toBe(true);
    // Déjà réaliste : aucun noyau ajouté, même après troncature.
    expect(durci).not.toContain("vidéo réaliste, rendu photoréaliste");
  });
});
