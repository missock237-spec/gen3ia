import { describe, expect, it } from "vitest";

import {
  MERGED_RESULTS_MAX,
  keyValueHitId,
  mergeMemoryResults,
  scoreKeyValueMatch,
  searchKeyValueEntries,
  type KeyValueMemoryEntry,
} from "./keyvalue-search";

const entries: KeyValueMemoryEntry[] = [
  { key: "projet.gen3ia.deadline", value: "Livraison le 30 septembre", updatedAt: "2026-09-20T10:00:00.000Z" },
  { key: "client.acme.contact", value: "Marie Dupont, marie@acme.test", updatedAt: "2026-09-21T09:00:00.000Z" },
  { key: "style.redaction", value: "Ton professionnel, phrases courtes", updatedAt: "2026-09-19T08:00:00.000Z" },
];

describe("scoreKeyValueMatch", () => {
  it("ne matche rien sans requête", () => {
    expect(scoreKeyValueMatch("", "projet", "valeur")).toBe(0);
    expect(scoreKeyValueMatch("   ", "projet", "valeur")).toBe(0);
  });

  it("classe : match exact > préfixe > sous-chaîne > valeur", () => {
    const exact = scoreKeyValueMatch("projet.gen3ia.deadline", "Projet.Gen3ia.Deadline", "peu importe");
    const prefix = scoreKeyValueMatch("projet.", "projet.gen3ia.deadline", "peu importe");
    const substring = scoreKeyValueMatch("deadline", "projet.gen3ia.deadline", "peu importe");
    const value = scoreKeyValueMatch("marie", "client.acme.contact", "Marie Dupont");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(value);
    expect(value).toBeGreaterThan(0);
  });

  it("est insensible à la casse et tolère les espaces", () => {
    expect(scoreKeyValueMatch("  PROJET.GEN3IA.DEADLINE ", "projet.gen3ia.deadline", "")).toBe(1);
  });

  it("retourne 0 hors correspondance", () => {
    expect(scoreKeyValueMatch("intranet", "projet.gen3ia.deadline", "Livraison le 30 septembre")).toBe(0);
  });
});

describe("searchKeyValueEntries", () => {
  it("exclut les entrées sans correspondance et renvoie des hits compatibles épisodiques", () => {
    const hits = searchKeyValueEntries(entries, "acme");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: keyValueHitId("client.acme.contact"),
      type: "keyvalue",
      content: "Marie Dupont, marie@acme.test",
      key: "client.acme.contact",
      source: "keyvalue",
    });
  });

  it("retrouve aussi une correspondance dans la valeur (bug 25-d : n=0)", () => {
    const hits = searchKeyValueEntries(entries, "livraison");
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("projet.gen3ia.deadline");
  });

  it("trie par score décroissant et borne au limit demandé", () => {
    const hits = searchKeyValueEntries(entries, "projet", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("projet.gen3ia.deadline");
    const tous = searchKeyValueEntries(entries, "o", 10); // « o » : sous-chaîne commune à plusieurs clés
    expect(tous.length).toBeGreaterThan(1);
    expect(tous[0].score).toBeGreaterThanOrEqual(tous[tous.length - 1].score);
  });
});

describe("mergeMemoryResults", () => {
  const episodic = [
    { id: "uuid-1", score: 0.42, source: "episodic" as const },
    { id: "uuid-2", score: 0.75, source: "episodic" as const },
  ];
  const keyvalue = [
    { id: "kv:projet.gen3ia.deadline", score: 1, source: "keyvalue" as const },
    { id: "kv:style.redaction", score: 0.42, source: "keyvalue" as const },
  ];

  it("fait remonter les meilleurs scores k/v ET épisodiques", () => {
    const merged = mergeMemoryResults(episodic, keyvalue);
    expect(merged.map((hit) => hit.id)).toEqual(["kv:projet.gen3ia.deadline", "uuid-2", "uuid-1", "kv:style.redaction"]);
  });

  it("déduplique par identifiant (les épisodiques passent en premier)", () => {
    const merged = mergeMemoryResults([{ id: "uuid-1", score: 0.9 }], [{ id: "uuid-1", score: 1 }], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.9);
  });

  it("applique le plafond de fusion (20 par défaut)", () => {
    const beaucoup = Array.from({ length: 30 }, (_, i) => ({ id: `kv:${i}`, score: 0.5 }));
    expect(mergeMemoryResults([], beaucoup)).toHaveLength(MERGED_RESULTS_MAX);
    expect(mergeMemoryResults([], beaucoup, 5)).toHaveLength(5);
  });

  it("gère les entrées vides", () => {
    expect(mergeMemoryResults([], [])).toEqual([]);
  });
});
