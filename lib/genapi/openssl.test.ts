import { describe, expect, it } from "vitest";

import {
  construireCommande,
  construireSujetClient,
  normaliserEmpreinte,
} from "@/lib/genapi/openssl";

/**
 * Tests PURS du terminal intégré genAPI — AUCUN binaire openssl requis :
 * validations d'identité (anti-injection), normalisation d'empreinte et
 * construction sûre des commandes (couple binaire/arguments, sans shell).
 */

/** Empreinte hexadécimale de test : "ab" répété 32 fois = 64 caractères. */
const EMPREINTE_AB = "ab".repeat(32);

describe("construireSujetClient — sujet OpenSSL canonique et validations", () => {
  it("uid valide → sujet /CN=gen3-client-{uid}/O=Gen3ia SaaS/OU=genAPI", () => {
    expect(construireSujetClient("u-abc-123")).toBe("/CN=gen3-client-u-abc-123/O=Gen3ia SaaS/OU=genAPI");
  });

  it("uid vide → rejet explicite", () => {
    expect(() => construireSujetClient("")).toThrow(/uid vide/);
  });

  it("uid avec « / » → rejet (anti-injection de chemin dans -subj)", () => {
    expect(() => construireSujetClient("u/abc")).toThrow(/caractère interdit/);
  });

  it("uid avec « \\ » → rejet", () => {
    expect(() => construireSujetClient("u\\abc")).toThrow(/caractère interdit/);
  });

  it("uid avec retour à la ligne → rejet (injection de sujet)", () => {
    expect(() => construireSujetClient("u\n/O=evil")).toThrow(/caractère interdit/);
    expect(() => construireSujetClient("u\r/O=evil")).toThrow(/caractère interdit/);
  });

  it("uid de 81 caractères → rejet (longueur bornée à 80)", () => {
    expect(() => construireSujetClient("u".repeat(81))).toThrow(/trop long/);
  });

  it("uid de 80 caractères exactement → accepté", () => {
    const uid = "u".repeat(80);
    expect(construireSujetClient(uid)).toContain(`CN=gen3-client-${uid}`);
  });
});

describe("normaliserEmpreinte — hex minuscule sans deux-points", () => {
  it("sortie OpenSSL brute « sha256 Fingerprint=AB:CD:… » → hex minuscule sans deux-points", () => {
    const brute = `sha256 Fingerprint=${"AB:".repeat(31)}AB`;
    expect(normaliserEmpreinte(brute)).toBe(EMPREINTE_AB);
  });

  it("empreinte déjà propre (majuscules) → minuscules", () => {
    expect(normaliserEmpreinte(EMPREINTE_AB.toUpperCase())).toBe(EMPREINTE_AB);
  });

  it("format varié (préfixe, espaces) → hex propre", () => {
    const brute = `sha256 Fingerprint= ${"ab ".repeat(31)}ab `;
    expect(normaliserEmpreinte(brute)).toBe(EMPREINTE_AB);
  });

  it("empreinte trop courte → rejet", () => {
    expect(() => normaliserEmpreinte("abcd")).toThrow(/invalide/);
  });

  it("empreinte non hexadécimale → rejet", () => {
    expect(() => normaliserEmpreinte(`zz${"ab".repeat(31)}`)).toThrow(/invalide/);
  });

  it("entrée non chaîne → rejet", () => {
    expect(() => normaliserEmpreinte(undefined as unknown as string)).toThrow(/invalide/);
  });
});

describe("construireCommande — couple binaire/arguments SANS shell", () => {
  it("binaire openssl fixe + tableau d'arguments tel quel", () => {
    const commande = construireCommande(["x509", "-in", "/tmp/client.crt", "-noout", "-fingerprint", "-sha256"]);
    expect(commande.binaire).toBe("openssl");
    expect(commande.args).toEqual(["x509", "-in", "/tmp/client.crt", "-noout", "-fingerprint", "-sha256"]);
  });

  it("aucune interpolation shell : l'argument avec espaces reste UN seul argument", () => {
    const commande = construireCommande(["req", "-new", "-key", "/tmp/ma clé.key", "-subj", "/CN=client/O=Gen3ia SaaS"]);
    expect(commande.args[3]).toBe("/tmp/ma clé.key");
    expect(commande.args[5]).toBe("/CN=client/O=Gen3ia SaaS");
  });

  it("copie défensive : muter la sortie ne corrompt pas l'entrée", () => {
    const entree = ["ecparam", "-genkey"];
    const commande = construireCommande(entree);
    commande.args.push("-injection");
    expect(entree).toEqual(["ecparam", "-genkey"]);
  });

  it("arguments invalides (non-chaînes) → rejet", () => {
    expect(() => construireCommande(["x509", 42 as unknown as string])).toThrow(/invalides/);
    expect(() => construireCommande(null as unknown as string[])).toThrow(/invalides/);
  });
});
