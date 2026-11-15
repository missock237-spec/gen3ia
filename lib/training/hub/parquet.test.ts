import { describe, expect, it } from "vitest";

import { HUB_DATASET_FILE_RE, HubError } from "./common";
import { estFichierParquet, lignesDepuisParquet, normaliserValeurParquet } from "./parquet";
import { fixturesParquet } from "./__fixtures__/parquet";

/* ------------------------------------------------------------------ */
/* PARQUET — parsing JS pur (hyparquet), plafonds et normalisation.     */
/* ------------------------------------------------------------------ */

describe("estFichierParquet", () => {
  it("reconnaît les noms HF réels (data/train-…-of-…-<hash>.parquet)", () => {
    expect(estFichierParquet("data/train-00000-of-00001-9e5f6b98c6d89c9a.parquet")).toBe(true);
    expect(estFichierParquet("train.parquet")).toBe(true);
    expect(estFichierParquet("FICHIER.PARQUET.GZ")).toBe(true);
    expect(estFichierParquet("train.csv")).toBe(false);
    expect(estFichierParquet("README.md")).toBe(false);
    expect(estFichierParquet("données.parquetx")).toBe(false);
  });

  it("l'extension .parquet passe le filtre hub (et README.md non)", () => {
    expect(HUB_DATASET_FILE_RE.test("data/train-00000-of-00001-abc123.parquet")).toBe(true);
    expect(HUB_DATASET_FILE_RE.test("notes.parquet")).toBe(true);
    expect(HUB_DATASET_FILE_RE.test("README.md")).toBe(false);
  });
});

describe("normaliserValeurParquet", () => {
  it("convertit les BigInt INT64 en nombre sûr (ou chaîne exacte)", () => {
    expect(normaliserValeurParquet(10n)).toBe(10);
    expect(normaliserValeurParquet(9_000_000_000n)).toBe(9_000_000_000);
    expect(normaliserValeurParquet(9_007_199_254_740_993n)).toBe("9007199254740993");
  });

  it("décode les BINARY UTF-8 stricts et ignore le vrai binaire", () => {
    expect(normaliserValeurParquet(new TextEncoder().encode("Bonjour Gen3ia"))).toBe("Bonjour Gen3ia");
    expect(normaliserValeurParquet(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]))).toBeNull();
  });

  it("normalise récursivement structs et tableaux (formes de chat)", () => {
    const normalise = normaliserValeurParquet({ messages: [{ role: "user", score: 1n }] }) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(normalise.messages[0]).toEqual({ role: "user", score: 1 });
  });

  it("rend null les nombres non finis", () => {
    expect(normaliserValeurParquet(Number.NaN)).toBeNull();
    expect(normaliserValeurParquet(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("lignesDepuisParquet", () => {
  it("parse un parquet snappy (question/answer) — convention HF fréquente", async () => {
    const { lignes, avertissements } = await lignesDepuisParquet(fixturesParquet().langageSnappy, "train.parquet", 100);
    expect(avertissements).toEqual([]);
    expect(lignes).toHaveLength(4);
    expect(lignes[0]).toMatchObject({
      question: "Comment fonctionne le réseau Gen3 ?",
      answer: "Un SNN à spikes entraîné par résonance.",
    });
    // INT64 → nombre (normalisation BigInt)
    expect(lignes[0]?.id).toBe(10_000_000_000);
  });

  it("parse un parquet SANS compression (text/label)", async () => {
    const { lignes } = await lignesDepuisParquet(fixturesParquet().intentionsSansCompr, "intentions.parquet", 100);
    expect(lignes).toHaveLength(4);
    expect(lignes[0]).toEqual({ text: "génère une image de montagne enneigée", label: "GENERER_IMAGE" });
    expect(lignes[3]).toEqual({ text: "appelle le contact urgence", label: "INITIALISER_APPEL" });
  });

  it("préserve les structures de chat (liste de structs {role, content})", async () => {
    const { lignes } = await lignesDepuisParquet(fixturesParquet().chatSnappy, "chat.parquet", 100);
    expect(lignes).toHaveLength(2);
    const messages = lignes[0]?.messages as Array<{ role: string; content: string }>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0]).toEqual({ role: "user", content: "Explique-moi les spikes." });
    expect(messages[1]).toEqual({ role: "assistant", content: "Un spike est un pulse bref du neurone." });
  });

  it("applique RÉELLEMENT le plafond de lignes (avertissement honnête)", async () => {
    const { lignes, avertissements } = await lignesDepuisParquet(fixturesParquet().grandSnappy, "grand.parquet", 10);
    expect(lignes).toHaveLength(10);
    expect(avertissements).toHaveLength(1);
    expect(avertissements[0]).toContain("30 lignes");
    expect(avertissements[0]).toContain("10 premières");
  });

  it("signale honnêtement un fichier parquet vide", async () => {
    const { lignes, avertissements } = await lignesDepuisParquet(fixturesParquet().videSnappy, "vide.parquet", 100);
    expect(lignes).toEqual([]);
    expect(avertissements).toHaveLength(1);
    expect(avertissements[0]).toContain("vide (0 ligne)");
  });

  it("lève une HubError lisible sur un parquet TRONQUÉ (mode partiel)", async () => {
    const buffer = fixturesParquet().grandSnappy.subarray(0, fixturesParquet().grandSnappy.byteLength - 200);
    const erreur = await lignesDepuisParquet(buffer, "data/train-00000-of-00001-abc.parquet", 100).catch(
      (e: unknown) => e,
    );
    expect(erreur).toBeInstanceOf(HubError);
    expect((erreur as Error).message).toContain("tronqué");
  });

  it("lève une HubError lisible sur des octets non parquet", async () => {
    const buffer = Buffer.from("ceci n'est pas un parquet, juste du texte", "utf8");
    const erreur = await lignesDepuisParquet(buffer, "faux.parquet", 100).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(HubError);
    expect((erreur as Error).message).toContain("parquet");
  });
});
