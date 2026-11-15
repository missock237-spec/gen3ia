import { afterAll, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "./secret-envelope";

const ORIGINAL_KEY = process.env.SECRETS_ENVELOPE_KEY;

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.SECRETS_ENVELOPE_KEY;
  else process.env.SECRETS_ENVELOPE_KEY = ORIGINAL_KEY;
});

describe("chiffrement envelope des secrets au repos", () => {
  it("chiffre et déchiffre un aller-retour exact (clé configurée)", () => {
    process.env.SECRETS_ENVELOPE_KEY = "cle-maitre-de-test-gen3ia-2026";
    const secret = "whsec_3f9a2b7c1d8e4f60a5b6c7d8e9f0a1b2";
    const stored = encryptSecret(secret);

    expect(stored).not.toBe(secret);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    // Aucune portion du secret en clair dans le stockage.
    expect(stored).not.toContain("whsec");
    expect(decryptSecret(stored)).toBe(secret);
  });

  it("produit des IV uniques (jamais deux fois le même chiffré)", () => {
    process.env.SECRETS_ENVELOPE_KEY = "cle-maitre-de-test-gen3ia-2026";
    const a = encryptSecret("meme-valeur");
    const b = encryptSecret("meme-valeur");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("meme-valeur");
    expect(decryptSecret(b)).toBe("meme-valeur");
  });

  it("valeurs héritées (clair, sans préfixe) renvoyées telles quelles", () => {
    process.env.SECRETS_ENVELOPE_KEY = "cle-maitre-de-test-gen3ia-2026";
    expect(decryptSecret("secret-heritage-sans-chiffrement")).toBe("secret-heritage-sans-chiffrement");
  });

  it("sans clé maître : stockage clair hérité (dégradation explicite)", () => {
    delete process.env.SECRETS_ENVELOPE_KEY;
    expect(encryptSecret("valeur")).toBe("valeur");
    expect(decryptSecret("valeur")).toBe("valeur");
  });

  it("corruption du chiffré détectée (GCM auth tag) — jamais de valeur fausse", () => {
    process.env.SECRETS_ENVELOPE_KEY = "cle-maitre-de-test-gen3ia-2026";
    const stored = encryptSecret("sensible");
    const corrupted = `${stored.slice(0, -4)}AAAA`;
    expect(() => decryptSecret(corrupted)).toThrow();
  });

  it("clé différente → déchiffrement impossible (rotation contrôlée)", () => {
    process.env.SECRETS_ENVELOPE_KEY = "cle-A";
    const stored = encryptSecret("sensible");
    process.env.SECRETS_ENVELOPE_KEY = "cle-B";
    expect(() => decryptSecret(stored)).toThrow();
  });
});
