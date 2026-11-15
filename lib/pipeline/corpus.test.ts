import { describe, expect, it } from "vitest";

import {
  PIPELINE_MAX_SEEN_HASHES,
  consommerJsonl,
  compterMots,
  enregistrerHash,
  isSha256Hex,
  nouvelIngestState,
  parserIngestState,
  validerRecord,
} from "./corpus";

/**
 * Protocole JSONL du corpus auto-apprentissage : règles de format,
 * qualité et dédoublonnage partagées daemon ↔ serveur (100 % pures).
 */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function recordValide(overrides: Record<string, unknown> = {}) {
  return {
    id: SHA_A,
    url: "https://example.com/article",
    title: "Article d'exemple",
    content:
      "Voici un contenu suffisamment long pour passer le filtre de qualité " +
      "exigé par le protocole du corpus auto-apprentissage sans ambiguïté aucune. ".repeat(10) +
      "Complément final pour dépasser largement le seuil des cent mots.",
    scrapedAt: "2026-01-15T10:30:00.000Z",
    metadata: { wordCount: 120, httpStatus: 200 },
    ...overrides,
  };
}

describe("isSha256Hex", () => {
  it("accepte un SHA-256 hexadécimal en minuscules", () => {
    expect(isSha256Hex(SHA_A)).toBe(true);
  });

  it("refuse majuscules, longueur invalide, non-chaîne", () => {
    expect(isSha256Hex(SHA_A.toUpperCase())).toBe(false);
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });
});

describe("compterMots", () => {
  it("compte les mots séparés par espaces multiples", () => {
    expect(compterMots("  un   deux\ttrois\nquatre ")).toBe(4);
  });

  it("renvoie 0 pour une chaîne vide ou blanche", () => {
    expect(compterMots("")).toBe(0);
    expect(compterMots("   \n\t ")).toBe(0);
  });
});

describe("validerRecord", () => {
  it("accepte un enregistrement complet et borne les champs", () => {
    const verdict = validerRecord(recordValide());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.record.id).toBe(SHA_A);
      expect(verdict.record.title).toBe("Article d'exemple");
    }
  });

  it("refuse id non SHA-256, URL invalide, contenu vide", () => {
    expect(validerRecord(recordValide({ id: "pas-un-hash" })).ok).toBe(false);
    expect(validerRecord(recordValide({ url: "ftp://x" })).ok).toBe(false);
    expect(validerRecord(recordValide({ content: "   " })).ok).toBe(false);
    expect(validerRecord(null).ok).toBe(false);
    expect(validerRecord("chaîne").ok).toBe(false);
  });

  it("refuse le contenu trop court (< 100 mots)", () => {
    const verdict = validerRecord(recordValide({ content: "trop court" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("trop court");
  });

  it("refuse le contenu > 2 Mo", () => {
    const gros = "mot ".repeat(600_000); // ~2.4 Mo
    const verdict = validerRecord(recordValide({ content: gros }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("2 Mo");
  });

  it("remplace un titre vide par l'URL et un scrapedAt absent par chaîne", () => {
    const verdict = validerRecord(recordValide({ title: "   ", scrapedAt: undefined }));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.record.title).toBe("https://example.com/article");
      expect(verdict.record.scrapedAt).toBe("");
    }
  });

  it("refuse un scrapedAt non chaîne", () => {
    expect(validerRecord(recordValide({ scrapedAt: 42 })).ok).toBe(false);
  });
});

describe("parserIngestState", () => {
  it("renvoie un état neuf si null ou JSON corrompu", () => {
    expect(parserIngestState(null)).toEqual(nouvelIngestState());
    expect(parserIngestState("{pas du json")).toEqual(nouvelIngestState());
  });

  it("refuse un offset négatif/non numérique", () => {
    expect(parserIngestState(JSON.stringify({ offset: -5, seenHashes: [] })).offset).toBe(0);
    expect(parserIngestState(JSON.stringify({ offset: "abc", seenHashes: [] })).offset).toBe(0);
  });

  it("filtre les empreintes non conformes", () => {
    const etat = parserIngestState(
      JSON.stringify({ offset: 120, seenHashes: [SHA_A, "bof", 42, SHA_B], updatedAt: "2026-01-15T00:00:00Z" }),
    );
    expect(etat.offset).toBe(120);
    expect(etat.seenHashes).toEqual([SHA_A, SHA_B]);
  });
});

describe("enregistrerHash", () => {
  it("ajoute sans doublon et plafonne en FIFO", () => {
    let etat = nouvelIngestState();
    etat = enregistrerHash(etat, SHA_A);
    etat = enregistrerHash(etat, SHA_A);
    expect(etat.seenHashes).toEqual([SHA_A]);

    // Registre déjà plein (construit en une fois) : l'ajout suivant
    // doit évincer les plus anciens (FIFO) et rester au plafond.
    const plein = Array.from({ length: PIPELINE_MAX_SEEN_HASHES }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    etat = enregistrerHash({ ...nouvelIngestState(), seenHashes: plein }, SHA_B);
    expect(etat.seenHashes.length).toBe(PIPELINE_MAX_SEEN_HASHES);
    expect(etat.seenHashes[PIPELINE_MAX_SEEN_HASHES - 1]).toBe(SHA_B);
    expect(etat.seenHashes.includes(plein[0])).toBe(false);
  });
});

describe("consommerJsonl", () => {
  function ligne(record: Record<string, unknown>): string {
    return JSON.stringify(record);
  }

  it("consomme des lignes complètes et calcule l'offset absolu", () => {
    const l1 = ligne(recordValide()) + "\n";
    const l2 = ligne(recordValide({ id: SHA_B, url: "https://example.com/2" })) + "\n";
    const lot = consommerJsonl(l1 + l2, 0, new Set());
    expect(lot.records.length).toBe(2);
    expect(lot.records[0].record.id).toBe(SHA_A);
    expect(lot.records[0].endOffset).toBe(Buffer.byteLength(l1, "utf-8"));
    expect(lot.records[1].endOffset).toBe(Buffer.byteLength(l1 + l2, "utf-8"));
    expect(lot.nextOffset).toBe(Buffer.byteLength(l1 + l2, "utf-8"));
    expect(lot.duplicates).toBe(0);
    expect(lot.failures.length).toBe(0);
  });

  it("ne consomme JAMAIS la dernière ligne incomplète (écriture en cours)", () => {
    const l1 = ligne(recordValide()) + "\n";
    const l2 = ligne(recordValide({ id: SHA_B })); // pas de \n final
    const brut = l1 + l2;
    const lot = consommerJsonl(brut, 0, new Set());
    expect(lot.records.length).toBe(1);
    expect(lot.records[0].record.id).toBe(SHA_A);
    expect(lot.nextOffset).toBe(Buffer.byteLength(l1, "utf-8"));
  });

  it("compte un bloc vide terminé par \\n comme complètement consommé", () => {
    const lot = consommerJsonl("", 40, new Set());
    expect(lot.records.length).toBe(0);
    expect(lot.nextOffset).toBe(40);
  });

  it("dédoublonne contre le registre et à l'intérieur du lot", () => {
    const l1 = ligne(recordValide()) + "\n";
    const l2 = ligne(recordValide()) + "\n"; // même SHA_A
    const interne = consommerJsonl(l1 + l2, 0, new Set());
    expect(interne.records.length).toBe(1);
    expect(interne.duplicates).toBe(1);

    const externe = consommerJsonl(l1, 0, new Set([SHA_A]));
    expect(externe.records.length).toBe(0);
    expect(externe.duplicates).toBe(1);
    // Ligne dédoublonnée quand même consommée (offset avance).
    expect(externe.nextOffset).toBe(Buffer.byteLength(l1, "utf-8"));
  });

  it("écarte les lignes invalides sans interrompre le lot", () => {
    const invalide = "{pas du json}\n";
    const courte = ligne(recordValide({ content: "trop court" })) + "\n";
    const valide = ligne(recordValide({ id: SHA_B })) + "\n";
    const lot = consommerJsonl(invalide + courte + valide, 0, new Set());
    expect(lot.records.length).toBe(1);
    expect(lot.records[0].record.id).toBe(SHA_B);
    expect(lot.failures.length).toBe(2);
    expect(lot.nextOffset).toBe(
      Buffer.byteLength(invalide + courte + valide, "utf-8"),
    );
  });
});
