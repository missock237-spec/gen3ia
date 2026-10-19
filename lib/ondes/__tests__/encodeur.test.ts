import { describe, expect, it } from "vitest";

import {
  CarteInverse,
  amplitudeMot,
  encoderTexte,
  fnv1a,
  signatureMot,
  tokenizeTexte,
} from "@/lib/ondes/encodeur";

describe("encodeur fréquentiel (W-DNN)", () => {
  it("hash FNV-1a : valeurs de référence du protocole", () => {
    // FNV-1a 32 bits — vecteur de test de la spécification.
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });

  it("tokenise le texte français (apostrophes, traits d'union)", () => {
    expect(tokenizeTexte("L'IA nouvelle-génération !")).toEqual(["l'ia", "nouvelle-génération"]);
    expect(tokenizeTexte("Énergie 100%%")).toEqual(["énergie", "100"]);
  });

  it("signature déterministe : même mot → même onde", () => {
    const a = signatureMot("résonance", 192);
    const b = signatureMot("résonance", 192);
    expect(a).toEqual(b);
    // Positions dans la grille, fréquence dans la bande utile.
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x).toBeLessThan(192);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeLessThan(192);
    expect(a.frequence).toBeGreaterThan(0);
    expect(a.frequence).toBeLessThan(0.2);
  });

  it("les répétitions renforcent l'amplitude sans dupliquer les impulsions", () => {
    const impulsions = encoderTexte("onde onde onde calme", 128);
    expect(impulsions).toHaveLength(2);
    const onde = impulsions.find((imp) => imp.frequence === signatureMot("onde", 128).frequence);
    const calme = impulsions.find((imp) => imp.frequence === signatureMot("calme", 128).frequence);
    expect(onde).toBeDefined();
    expect(calme).toBeDefined();
    expect(onde!.amplitude).toBeGreaterThan(calme!.amplitude);
    // Plafond d'amplitude respecté.
    expect(onde!.amplitude).toBeLessThanOrEqual(12);
  });

  it("amplitude proportionnelle à la longueur du mot, bornée", () => {
    expect(amplitudeMot("a")).toBeLessThan(amplitudeMot("anticonstitutionnellement"));
    expect(amplitudeMot("a".repeat(40))).toBe(6);
  });

  it("carte inverse : un pic redevient le mot qui l'a excité", () => {
    const carte = new CarteInverse();
    const dim = 128;
    const mots = ["photon", "synapse", "cascade"];
    for (const mot of mots) carte.enregistrer(mot, dim);
    expect(carte.taille).toBe(mots.length);

    for (const mot of mots) {
      const sig = signatureMot(mot, dim);
      expect(carte.motLePlusProche(sig.x, sig.y, dim)).toBe(mot);
    }
    // Loin de tout vocabulaire → aucun mot.
    expect(carte.motLePlusProche(0, 0, dim, 2)).toBe(null);
  });

  it("la carte inverse survit à un ré-enregistrement (même mot)", () => {
    const carte = new CarteInverse();
    carte.enregistrer("hologramme", 128);
    carte.enregistrer("hologramme", 128);
    const sig = signatureMot("hologramme", 128);
    expect(carte.motLePlusProche(sig.x, sig.y, 128)).toBe("hologramme");
    carte.reinitialiser();
    expect(carte.taille).toBe(0);
    expect(carte.motLePlusProche(sig.x, sig.y, 128)).toBe(null);
  });
});
