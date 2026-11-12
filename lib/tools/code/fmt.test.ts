import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { outilDevFmt } from "./fmt";

/**
 * Tests de l'outil `dev.fmt` — formatage/normalisation 100 % déterministe.
 * Les empreintes SHA-256 attendues sont pré-calculées avec node:crypto.
 */

const CONTEXTE = { userId: "utilisateur-test", executionId: "exec-test" };

describe("dev.fmt — json", () => {
  it("formate avec l'indent demandé et produit la version compacte", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "json", contenu: '{"a":1,"b":[2,3]}' }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.jsonFormate).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(resultat.jsonCompacte).toBe('{"a":1,"b":[2,3]}');
  });

  it("respecte indent=0 (compact) et indent=4", async () => {
    const compact = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "json", contenu: '{"x":{"y":1}}', indent: 0 }),
      CONTEXTE,
    );
    expect(compact.jsonFormate).toBe('{"x":{"y":1}}');
    const large = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "json", contenu: '{"x":{"y":1}}', indent: 4 }),
      CONTEXTE,
    );
    expect(large.jsonFormate).toBe('{\n    "x": {\n        "y": 1\n    }\n}');
  });

  it("refuse un JSON invalide avec message honnête (position si V8 la fournit)", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "json", contenu: '{\n  "a": 1,\n}' }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur?.message).toBeTruthy();
    if (resultat.erreur?.ligne !== undefined) {
      expect(resultat.erreur.ligne).toBeGreaterThanOrEqual(1);
    }
    expect(resultat.jsonFormate).toBeUndefined();
  });
});

describe("dev.fmt — base64", () => {
  it("encode en UTF-8 puis redécode fidèlement (allers-retours)", async () => {
    const source = "Drapeau 🚩 et accents éàü";
    const encode = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "base64", sens: "encoder", contenu: source }),
      CONTEXTE,
    );
    expect(encode.base64).toBe(Buffer.from(source, "utf-8").toString("base64"));
    const decode = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "base64", sens: "decoder", contenu: encode.base64! }),
      CONTEXTE,
    );
    expect(decode.texteDecode).toBe(source);
  });

  it("refuse un alphabet invalide honnêtement", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "base64", sens: "decoder", contenu: "abc$def!" }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur?.message).toMatch(/base64 invalide/);
  });

  it("refuse une longueur/bourrage incorrect (décodage non fidèle)", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "base64", sens: "decoder", contenu: "QUJD" }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true); // « ABC » — cas valide de contrôle
    const bourrage = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "base64", sens: "decoder", contenu: "QUJDRA==" }),
      CONTEXTE,
    );
    expect(bourrage.succes).toBe(true);
    expect(bourrage.texteDecode).toBe("ABCD");
    const faux = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "base64", sens: "decoder", contenu: "QUJ=" }),
      CONTEXTE,
    );
    expect(faux.succes).toBe(false);
    expect(faux.erreur?.message).toMatch(/non fidèle|longueur/);
  });
});

describe("dev.fmt — hash SHA-256", () => {
  it("calcule l'empreinte hexadécimale et la taille en octets", async () => {
    const attendu = createHash("sha256").update("gen3ia", "utf-8").digest("hex");
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "hash", contenu: "gen3ia" }),
      CONTEXTE,
    );
    expect(resultat.sha256).toBe(attendu);
    expect(resultat.tailleOctets).toBe("gen3ia".length);
  });

  it("traite correctement les caractères multi-octets", async () => {
    const attendu = createHash("sha256").update("🚩", "utf-8").digest("hex");
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "hash", contenu: "🚩" }),
      CONTEXTE,
    );
    expect(resultat.sha256).toBe(attendu);
    expect(resultat.tailleOctets).toBe(4);
  });
});

describe("dev.fmt — url", () => {
  it("démonte une URL complète (protocole, hôte, chemin, params, ancre) et resérialise", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({
        operation: "url",
        contenu: "https://api.exemple.com:8443/v1/produits?page=2&tri=prix&filtre=a%20b#resume",
      }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.composantsUrl).toEqual({
      protocole: "https",
      hote: "api.exemple.com",
      port: "8443",
      chemin: "/v1/produits",
      recherche: "?page=2&tri=prix&filtre=a%20b",
      parametres: [
        { nom: "page", valeur: "2" },
        { nom: "tri", valeur: "prix" },
        { nom: "filtre", valeur: "a b" },
      ],
      ancre: "#resume",
      serialise: "https://api.exemple.com:8443/v1/produits?page=2&tri=prix&filtre=a%20b#resume",
    });
  });

  it("refuse une URL invalide honnêtement", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "url", contenu: "pas-une-url" }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur?.message).toMatch(/URL invalide/);
  });
});

describe("dev.fmt — html", () => {
  it("échappe &, <, >, guillemets et apostrophes", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({
        operation: "html",
        contenu: '<a href="/x?t=1&u=2">Cliquez "ici" & l\'envoyer</a>',
      }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.htmlEchappe).toBe(
      "&lt;a href=&quot;/x?t=1&amp;u=2&quot;&gt;Cliquez &quot;ici&quot; &amp; l&#39;envoyer&lt;/a&gt;",
    );
  });

  it("laisse inchangé un texte sans caractère spécial", async () => {
    const resultat = await outilDevFmt.execute(
      outilDevFmt.inputSchema.parse({ operation: "html", contenu: "texte simple" }),
      CONTEXTE,
    );
    expect(resultat.htmlEchappe).toBe("texte simple");
  });
});

describe("dev.fmt — schéma", () => {
  it("refuse une opération inconnue et des contenus hors borne", () => {
    expect(outilDevFmt.inputSchema.safeParse({ operation: "inconnu", contenu: "x" }).success).toBe(false);
    expect(outilDevFmt.inputSchema.safeParse({ operation: "json", contenu: "" }).success).toBe(false);
    expect(outilDevFmt.inputSchema.safeParse({ operation: "json", contenu: "x".repeat(200_001) }).success).toBe(false);
    expect(outilDevFmt.inputSchema.safeParse({ operation: "base64", contenu: "x" }).success).toBe(false);
  });
});
