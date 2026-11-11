import { describe, expect, it } from "vitest";

import {
  besoinRechercheTempsReel,
  requeteDepuisMessage,
} from "./recherche-temps-reel";

describe("conversation — détection déterministe du besoin de recherche temps réel", () => {
  it("détecte les signaux d'actualité courants", () => {
    expect(besoinRechercheTempsReel("Quelles sont les actualités aujourd'hui ?").besoin).toBe(true);
    expect(besoinRechercheTempsReel("Quel est le cours de l'ethereum en ce moment ?").besoin).toBe(true);
    expect(besoinRechercheTempsReel("Quelle est la météo à Douala ce matin ?").besoin).toBe(true);
    expect(besoinRechercheTempsReel("Quel est le score du match de hier soir ?").besoin).toBe(true);
    expect(besoinRechercheTempsReel("C'est quoi la dernière version de Next.js ?").besoin).toBe(true);
  });

  it("détecte les commandes explicites de recherche web", () => {
    expect(besoinRechercheTempsReel("Cherche sur le web les dernières annonces de la BCEAO").besoin).toBe(true);
    expect(besoinRechercheTempsReel("Informes-toi sur la situation économique camerounaise").besoin).toBe(true);
  });

  it("ne déclenche PAS pour une question de savoir stable", () => {
    expect(besoinRechercheTempsReel("Explique-moi le théorème de Pythagore").besoin).toBe(false);
    expect(besoinRechercheTempsReel("Comment on dit « maison » en espagnol ?").besoin).toBe(false);
    expect(besoinRechercheTempsReel("Écris une fonction JavaScript qui trie un tableau").besoin).toBe(false);
  });

  it("ne déclenche PAS quand le message contient une URL (autre chemin)", () => {
    expect(besoinRechercheTempsReel("Résume cet article : https://exemple.com/actualites-du-jour").besoin).toBe(false);
  });

  it("ne déclenche PAS pour un message trop court", () => {
    expect(besoinRechercheTempsReel("salut").besoin).toBe(false);
  });

  it("le signal détecté est traçable", () => {
    const resultat = besoinRechercheTempsReel("Quelles sont les dernières actualités du Cameroun ?");
    expect(resultat.besoin).toBe(true);
    expect(resultat.signal).toContain("actualités");
  });
});

describe("conversation — requête moteur depuis le message utilisateur", () => {
  it("retire les préfixes de politesse et de conversation", () => {
    expect(requeteDepuisMessage("Salut, quel est le prix du cacao aujourd'hui ?")).toBe(
      "quel est le prix du cacao aujourd'hui",
    );
    expect(requeteDepuisMessage("Dis-moi les dernières actualités sur l'IA")).toBe(
      "les dernières actualités sur l'IA",
    );
  });

  it("borne la requête à 300 caractères", () => {
    const long = "actualités ".repeat(60);
    expect(requeteDepuisMessage(long).length).toBeLessThanOrEqual(300);
  });

  it("un message déjà propre reste inchangé", () => {
    expect(requeteDepuisMessage("cours du pétrole")).toBe("cours du pétrole");
  });
});
