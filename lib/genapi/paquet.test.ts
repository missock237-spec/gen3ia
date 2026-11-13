import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  JETON_TTL_MS,
  construirePaquet,
  extrairePaquet,
  genererJetonUsageUnique,
  hasherJeton,
} from "@/lib/genapi/paquet";

/**
 * Tests du paquet genAPI (tar maison déterministe + gzip) et du jeton
 * d'usage unique — 100 % PURS : aucune I/O, aucune dépendance réseau.
 */

describe("construirePaquet / extrairePaquet — aller-retour exact", () => {
  it("aller-retour multi-fichiers (texte FR + contenu binaire)", () => {
    const contenuBinaire = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
    const fichiers = [
      { nom: "LISEZMOI.md", contenu: "# Paquet genAPI — clé privée à garder secrète\n" },
      { nom: "gen3.proto", contenu: "syntax = \"proto3\";\npackage gen3.v1;\n" },
      { nom: "client.key", contenu: contenuBinaire },
      { nom: "répertoire-données/cahier-des-charges.txt", contenu: "Texte accentué : café — pièce nº1\n" },
    ];
    const paquet = construirePaquet(fichiers);
    const extraits = extrairePaquet(paquet);

    expect(extraits).toHaveLength(4);
    expect(extraits.map((f) => f.nom)).toEqual([
      "LISEZMOI.md",
      "gen3.proto",
      "client.key",
      "répertoire-données/cahier-des-charges.txt",
    ]);
    expect(extraits[0]!.contenu.toString("utf8")).toBe(fichiers[0]!.contenu);
    expect(extraits[1]!.contenu.toString("utf8")).toBe(fichiers[1]!.contenu);
    expect(Buffer.compare(extraits[2]!.contenu, contenuBinaire)).toBe(0);
    expect(extraits[3]!.contenu.toString("utf8")).toContain("café — pièce nº1");
  });

  it("gzip déterministe : même contenu → mêmes octets (pas d'horodatage)", () => {
    const fichiers = [{ nom: "gen3.proto", contenu: "package gen3.v1;" }];
    expect(Buffer.compare(construirePaquet(fichiers), construirePaquet(fichiers))).toBe(0);
  });

  it("paquet vide (aucun fichier) → extraction vide", () => {
    expect(extrairePaquet(construirePaquet([]))).toEqual([]);
  });

  it("paquet gzip corrompu → erreur propre (pas de segmentation)", () => {
    const paquet = construirePaquet([{ nom: "client.crt", contenu: "certificat" }]);
    const corrompu = Buffer.from(paquet);
    corrompu[corrompu.length - 5] = corrompu[corrompu.length - 5]! ^ 0xff;
    expect(() => extrairePaquet(corrompu)).toThrow(/décompression impossible/);
  });

  it("tailles incohérentes (contenu tronqué) → erreur propre", () => {
    // Entête annonçant 100 octets de contenu pour un nom de 1 octet, puis rien.
    const brut = Buffer.alloc(2 + 1 + 4);
    brut.writeUInt16BE(1, 0);
    brut.write("k", 2, "utf8");
    brut.writeUInt32BE(100, 3);
    expect(() => extrairePaquet(gzipSync(brut))).toThrow(/tronqué/);
  });

  it("entrée invalide → erreur explicite", () => {
    expect(() => construirePaquet([{ nom: "", contenu: "x" }])).toThrow(/nom de fichier requis/);
    expect(() => construirePaquet([{ nom: "ok.txt", contenu: undefined as unknown as string }])).toThrow(/contenu invalide/);
    expect(() => extrairePaquet("paquet" as unknown as Buffer)).toThrow(/Buffer requis/);
  });
});

describe("hasherJeton — SHA-256 hex déterministe", () => {
  it("valeur connue : sha256('test')", () => {
    const attendu = createHash("sha256").update("test", "utf8").digest("hex");
    expect(hasherJeton("test")).toBe(attendu);
  });

  it("déterministe : même entrée → même hash", () => {
    expect(hasherJeton("jeton-gen3")).toBe(hasherJeton("jeton-gen3"));
  });

  it("format hexadécimal 64 caractères minuscules", () => {
    expect(hasherJeton("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("genererJetonUsageUnique — 32 octets CSPRNG en base64url", () => {
  it("unicité : 50 générations sans collision", () => {
    const jetons = new Set<string>();
    for (let i = 0; i < 50; i += 1) jetons.add(genererJetonUsageUnique().jeton);
    expect(jetons.size).toBe(50);
  });

  it("jeton base64url pur (pas de +, / ou =)", () => {
    for (let i = 0; i < 20; i += 1) {
      const { jeton } = genererJetonUsageUnique();
      expect(jeton).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
    }
  });

  it("hashJeton = hasherJeton(jeton) — le CLAIR n'est jamais persisté, son hash est l'identifiant", () => {
    const { jeton, hashJeton } = genererJetonUsageUnique();
    expect(hashJeton).toBe(hasherJeton(jeton));
    expect(hashJeton).toMatch(/^[0-9a-f]{64}$/);
    expect(hashJeton).not.toContain(jeton);
  });

  it("TTL du jeton = 15 minutes", () => {
    expect(JETON_TTL_MS).toBe(15 * 60 * 1000);
  });
});
