import { describe, expect, it } from "vitest";

import {
  PLAFOND_DEFAUT_TTS,
  cancelSpeech,
  estSyntheseDisponible,
  isSpeaking,
  nettoyerPourVoix,
  speakFr,
  tronquerFinDePhrase,
} from "./voice-speak";

/**
 * Tests de la brique TTS native (chat voix — envoi sans prompt écrit).
 * Environnement vitest = node (PAS de jsdom dans le dépôt) : les gardes
 * SSR/support sont donc réellement exercées (window undefined), et la
 * logique pure (nettoyage markdown, troncation à fin de phrase) est
 * verrouillée indépendamment du navigateur.
 */
describe("voice-speak — logique pure", () => {
  describe("nettoyerPourVoix", () => {
    it("supprime les blocs de code (non épelés à voix haute)", () => {
      const texte = nettoyerPourVoix("Voici le code :\n```js\nconst a = 1;\n```\nBonne journée.");
      expect(texte).not.toContain("const a");
      expect(texte).not.toContain("```");
      expect(texte).toContain("Voici le code :");
      expect(texte).toContain("Bonne journée.");
    });

    it("garde le libellé des liens et retire les images", () => {
      const texte = nettoyerPourVoix("Voir [la documentation](https://example.com) et ![logo](x.png).");
      expect(texte).toContain("Voir la documentation et .");
      expect(texte).not.toContain("https://example.com");
      expect(texte).not.toContain("logo");
    });

    it("retire la mise en forme markdown et compacte les espaces", () => {
      expect(nettoyerPourVoix("# Titre\n\n**gras** et _italique_")).toBe("Titre gras et italique");
    });
  });

  describe("tronquerFinDePhrase", () => {
    it("ne tronque pas un texte sous le plafond", () => {
      expect(tronquerFinDePhrase("Bonjour !", 100)).toBe("Bonjour !");
      expect(PLAFOND_DEFAUT_TTS).toBe(1500);
    });

    it("tronque PROPREMENT à la dernière fin de phrase incluse", () => {
      const texte = "Première phrase. Deuxième phrase qui dépasse largement le plafond fixé.";
      const resultat = tronquerFinDePhrase(texte, 30);
      expect(resultat).toBe("Première phrase.");
    });

    it("coupe au dernier espace (jamais en plein mot) avec suspension sinon", () => {
      const texte = "MotLongueChaineSansPonctuation " .repeat(10) + "fin";
      const resultat = tronquerFinDePhrase(texte, 40);
      expect(resultat.startsWith("MotLongueChaineSansPonctuation")).toBe(true);
      expect(resultat.endsWith("…")).toBe(true);
      expect(resultat.length).toBeLessThanOrEqual(41);
    });

    it("retourne une chaîne vide pour un plafond nul", () => {
      expect(tronquerFinDePhrase("Texte.", 0)).toBe("");
    });
  });

  describe("gardes SSR / support (window undefined en environnement node)", () => {
    it("estSyntheseDisponible() = false hors navigateur", () => {
      expect(estSyntheseDisponible()).toBe(false);
    });

    it("speakFr() retourne false (réponse textuelle, pas de simulation)", () => {
      expect(speakFr("Bonjour", { onFin: () => undefined })).toBe(false);
    });

    it("isSpeaking() = false hors navigateur", () => {
      expect(isSpeaking()).toBe(false);
    });

    it("cancelSpeech() ne crash pas hors navigateur", () => {
      expect(() => cancelSpeech()).not.toThrow();
    });
  });
});
