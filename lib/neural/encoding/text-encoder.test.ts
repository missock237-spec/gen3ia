import { describe, expect, it } from "vitest";

import {
  tokenize,
  hashToken,
  encodeText,
  getTokensForNeuron,
  exporterRegistreTokens,
  importerRegistreTokens,
} from "./text-encoder";

/**
 * ENCODAGE DE TEXTE — tests unitaires :
 *  - hash FNV-1a stable et déterministe ;
 *  - chaque token tombe dans la zone 0..37 ;
 *  - normalisation des diacritiques (NFD) ;
 *  - accumulation d'intensité par occurrence + cap 3.0 par neurone ;
 *  - registre inverse (neurone → tokens, max 6, FIFO).
 */

describe("tokenize", () => {
  it("minuscules + suppression des diacritiques + split non-alphanumérique", () => {
    expect(tokenize("Éléphant Café café")).toEqual([
      "elephant",
      "cafe",
      "cafe",
    ]);
    expect(tokenize("Ça va trèS bien ?")).toEqual(["ca", "va", "tres", "bien"]);
    expect(tokenize("  Hello,  World!!  ")).toEqual(["hello", "world"]);
    expect(tokenize("l'été à Paris")).toEqual(["l", "ete", "a", "paris"]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize("123 456")).toEqual(["123", "456"]);
  });
});

describe("hashToken", () => {
  it("stable : le même token produit toujours le même hash", () => {
    const a = hashToken("bonjour");
    const b = hashToken("bonjour");
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    // FNV-1a 32 bits non signé.
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it("discriminant : deux tokens différents (quasi certainement) diffèrent", () => {
    expect(hashToken("bonjour")).not.toBe(hashToken("salut"));
    expect(hashToken("image")).not.toBe(hashToken("imag"));
  });
});

describe("encodeText", () => {
  it("chaque token tombe dans la zone de tokens 0..37", () => {
    const texte =
      "Bonjour le monde, voici une phrase assez longue pour couvrir " +
      "plusieurs tokens différents : alpha beta gamma delta epsilon zeta.";
    const { neuronTokens, inputs } = encodeText(texte);

    expect(neuronTokens.length).toBeGreaterThan(5);
    for (const { neuron } of neuronTokens) {
      expect(neuron).toBeGreaterThanOrEqual(0);
      expect(neuron).toBeLessThanOrEqual(37);
    }
    // Les entrées portent sur les mêmes neurones.
    for (const id of Object.keys(inputs)) {
      const n = Number(id);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(37);
    }
  });

  it("intensité 1.2 par occurrence, cumulée par neurone", () => {
    // « café » et « cafe » se normalisent vers le même token « cafe ».
    const { inputs } = encodeText("café cafe");
    const neuron = hashToken("cafe") % 38;
    expect(inputs[neuron]).toBeCloseTo(2.4, 12);
  });

  it("cap d'intensité à 3.0 par neurone", () => {
    const { inputs } = encodeText("image image image image image image");
    const neuron = hashToken("image") % 38;
    // 6 occurrences × 1.2 = 7.2 → plafonné à 3.0.
    expect(inputs[neuron]).toBe(3);
  });

  it("déterministe : le même texte produit exactement les mêmes entrées", () => {
    const a = encodeText("Génère une image de montagne");
    const b = encodeText("génère UNE image de montagne");
    expect(a.inputs).toEqual(b.inputs);
  });
});

describe("registre inverse (neurone → tokens)", () => {
  it("getTokensForNeuron retourne les tokens enregistrés", () => {
    encodeText("bonjour le monde");
    const neuron = hashToken("bonjour") % 38;
    expect(getTokensForNeuron(neuron)).toContain("bonjour");
  });

  it("borné à 6 tokens par neurone (FIFO)", () => {
    // Recherche déterministe de 7 tokens qui hachent vers le même neurone.
    const parNeurone = new Map<number, string[]>();
    for (let i = 0; i < 4000 && (parNeurone.get(9)?.length ?? 0) < 7; i++) {
      const token = `t${i}`;
      const neuron = hashToken(token) % 38;
      const liste = parNeurone.get(neuron) ?? [];
      liste.push(token);
      parNeurone.set(neuron, liste);
    }
    const neuroneCible = Array.from(parNeurone.entries()).find(
      ([, tokens]) => tokens.length >= 7,
    );
    expect(neuroneCible).toBeDefined();

    const [neuron, tokens] = neuroneCible!;
    encodeText(tokens.join(" "));
    const enregistres = getTokensForNeuron(neuron);
    expect(enregistres.length).toBe(6);
    // FIFO : le plus ancien (t0) a été évincé, les 6 suivants restent.
    expect(enregistres).toEqual(tokens.slice(1, 7));
  });

  it("export/import : le registre survit à un aller-retour", () => {
    encodeText("montagne riviere foret");
    const exporte = exporterRegistreTokens();
    expect(Object.keys(exporte).length).toBeGreaterThan(0);

    importerRegistreTokens(exporte);
    const reexporte = exporterRegistreTokens();
    expect(reexporte).toEqual(exporte);
  });
});
