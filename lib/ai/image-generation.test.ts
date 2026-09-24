import { describe, expect, it } from "vitest";

import {
  detectImageRatio,
  extractImagePrompt,
  looksLikeExplicitDrawingRequest,
  looksLikeImageRequest,
} from "./image-generation";

describe("looksLikeImageRequest — détection d'intention image", () => {
  it("détecte les formulations explicites classiques", () => {
    expect(looksLikeImageRequest("Génère une image d'un lion doré au coucher du soleil.")).toBe(true);
    expect(looksLikeImageRequest("Crée une image de chat qui dort.")).toBe(true);
    expect(looksLikeImageRequest("Dessine-moi un paysage de montagne.")).toBe(true);
    expect(looksLikeImageRequest("Fais-moi un logo pour ma boulangerie.")).toBe(true);
  });

  it("détecte les formulations de volonté (retour utilisateur : demande manquée)", () => {
    expect(looksLikeImageRequest("Je veux une image de chien en costume.")).toBe(true);
    expect(looksLikeImageRequest("Je voudrais une illustration de tour Eiffel.")).toBe(true);
    expect(looksLikeImageRequest("J'aimerais un dessin de dragon.")).toBe(true);
    expect(looksLikeImageRequest("J'ai besoin d'une photo de plage tropicale.")).toBe(true);
    expect(looksLikeImageRequest("Peux-tu me faire un portrait de femme au chapeau ?")).toBe(true);
  });

  it("détecte un visuel en tête de message", () => {
    expect(looksLikeImageRequest("Un logo pour ma boulangerie")).toBe(true);
    expect(looksLikeImageRequest("Une image d'un chat roux")).toBe(true);
    expect(looksLikeImageRequest("Mon avatar de profil professionnel")).toBe(true);
  });

  it("ne déclenche PAS pour une question explicative", () => {
    expect(looksLikeImageRequest("Comment créer une image de qualité ?")).toBe(false);
    expect(looksLikeImageRequest("C'est quoi un logo vectoriel ?")).toBe(false);
    expect(looksLikeImageRequest("Pourquoi mes photos sont-elles floues ?")).toBe(false);
  });

  it("ne déclenche PAS pour une action sur une image existante", () => {
    expect(looksLikeImageRequest("Analyse cette photo et dis-moi ce que tu vois.")).toBe(false);
    expect(looksLikeImageRequest("Supprime l'image rapport.png de mon espace.")).toBe(false);
    expect(looksLikeImageRequest("Télécharge l'image du brief dans mes fichiers.")).toBe(false);
    expect(looksLikeImageRequest("Je veux comprendre cette image.")).toBe(false);
  });

  it("lève le garde d'analyse quand un verbe de génération coexiste", () => {
    expect(looksLikeImageRequest("Analyse ma demande puis génère une image d'un vaisseau spatial.")).toBe(true);
  });

  it("ne déclenche PAS sans nom visuel", () => {
    expect(looksLikeImageRequest("Écris-moi un poème sur l'automne.")).toBe(false);
    expect(looksLikeImageRequest("Génère un rapport de ventes.")).toBe(false);
  });

  it("reste robuste sur les accents et la ponctuation", () => {
    expect(looksLikeImageRequest("Généré une image pour moi ? non — génère une image d'un loup !")).toBe(true);
    expect(looksLikeImageRequest("crée une image de navire")).toBe(true);
  });
});

describe("looksLikeExplicitDrawingRequest — verbes de dessin explicites", () => {
  it("déclenche SANS nom visuel (ancienne faille : réponse texte au lieu d'une image)", () => {
    expect(looksLikeExplicitDrawingRequest("Dessine-moi un chat qui dort sur un coussin rouge.")).toBe(true);
    expect(looksLikeExplicitDrawingRequest("Dessine un dragon cracheur de feu.")).toBe(true);
    expect(looksLikeExplicitDrawingRequest("Peux-tu dessiner la tour Eiffel ?")).toBe(true);
    expect(looksLikeExplicitDrawingRequest("Dessinez un paysage de montagne enneigée.")).toBe(true);
    expect(looksLikeExplicitDrawingRequest("Peins la baie de Somme au crépuscule.")).toBe(true);
  });

  it("ne déclenche PAS pour le NOM « dessin » (œuvre existante)", () => {
    expect(looksLikeExplicitDrawingRequest("Ce dessin est très réussi.")).toBe(false);
    expect(looksLikeExplicitDrawingRequest("Tes dessins sont magnifiques.")).toBe(false);
    expect(looksLikeExplicitDrawingRequest("Supprime le dessin brouillon.png de mes fichiers.")).toBe(false);
  });

  it("ne déclenche PAS pour une question explicative", () => {
    expect(looksLikeExplicitDrawingRequest("Comment dessiner un chat réaliste ?")).toBe(false);
  });
});

describe("detectImageRatio — cadrage déduit de la demande", () => {
  it("respecte un ratio explicite", () => {
    expect(detectImageRatio("Génère une image 16:9 d'un paysage")).toBe("16:9");
    expect(detectImageRatio("une photo 9:16 de chaton")).toBe("9:16");
  });

  it("déduit le format depuis les indices de cadrage", () => {
    expect(detectImageRatio("une bannière pour mon site web")).toBe("16:9");
    expect(detectImageRatio("un fond d'écran de forêt")).toBe("16:9");
    expect(detectImageRatio("une story instagram avec un coucher de soleil")).toBe("9:16");
    expect(detectImageRatio("un poster de concert")).toBe("3:4");
  });

  it("reste carré par défaut", () => {
    expect(detectImageRatio("Génère une image d'un lion doré")).toBe("1:1");
    expect(detectImageRatio("un logo pour ma boulangerie")).toBe("1:1");
  });
});

describe("extractImagePrompt — nettoyage des formules d'introduction", () => {
  it("retire les formulations classiques", () => {
    expect(extractImagePrompt("Génère une image d'un lion doré")).toBe("un lion doré");
    // Sans nom visuel dans la formule d'intro, le message entier reste
    // (Agnes le comprend très bien tel quel).
    expect(extractImagePrompt("Dessine-moi un chat qui dort")).toBe("Dessine-moi un chat qui dort");
  });

  it("retire les formulations de volonté et de politesse", () => {
    expect(extractImagePrompt("Je veux une image de chien en costume")).toBe("chien en costume");
    expect(extractImagePrompt("Peux-tu me faire un portrait de femme au chapeau ?")).toBe(
      "femme au chapeau ?",
    );
    expect(extractImagePrompt("S'il te plaît, génère-moi une photo de plage tropicale")).toBe(
      "plage tropicale",
    );
    expect(extractImagePrompt("J'ai besoin d'une photo de plage tropicale")).toBe("plage tropicale");
  });

  it("conserve le message entier si rien ne se nettoie", () => {
    expect(extractImagePrompt("un lion doré au coucher du soleil")).toBe("un lion doré au coucher du soleil");
  });

  it("ne renvoie jamais de prompt vide", () => {
    expect(extractImagePrompt("génère une image")).toBeTruthy();
  });
});
