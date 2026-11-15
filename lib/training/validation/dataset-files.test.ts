import { describe, expect, it } from "vitest";

import { auditSplits, validateDatasetFile } from "./dataset-files";

/* ------------------------------------------------------------------ */
/* Validation des datasets — analyse réelle du contenu (spec §4).       */
/* ------------------------------------------------------------------ */

describe("validateDatasetFile — CSV", () => {
  it("compte lignes, colonnes et paires instruction/réponse", () => {
    const csv = [
      "instruction,response",
      "Quelle est la capitale du Mali ?,Bamako",
      "Qui a écrit Les Misérables ?,Victor Hugo",
      "Quelle est la capitale du Mali ?,Bamako",
      "",
    ].join("\n");
    const report = validateDatasetFile("train.csv", Buffer.from(csv, "utf8"));
    expect(report.status).toBe("valid");
    expect(report.format).toBe("csv");
    expect(report.stats.rows).toBe(3);
    expect(report.stats.columns).toEqual(["instruction", "response"]);
    expect(report.stats.pairs).toBe(1);
    expect(report.stats.duplicates).toBe(1);
    // Le saut de ligne final n'est pas une ligne vide : aucun trou réel ici.
    expect(report.stats.emptyLines).toBe(0);
  });

  it("détecte le point-virgule comme délimiteur", () => {
    const csv = "question;réponse\nQ1;R1";
    const report = validateDatasetFile("data.csv", Buffer.from(csv, "utf8"));
    expect(report.stats.columns).toEqual(["question", "réponse"]);
    expect(report.stats.rows).toBe(1);
  });

  it("avertit quand le dataset est trop petit", () => {
    const csv = ["instruction,response", "Q1,R1", "Q2,R2"].join("\n");
    const report = validateDatasetFile("tiny.csv", Buffer.from(csv, "utf8"));
    expect(report.stats.warnings.some((w) => w.includes("très petit"))).toBe(true);
    expect(report.findings.some((f) => f.code === "dataset-too-small")).toBe(true);
  });

  it("avertit RGPD quand des emails sont présents en nombre", () => {
    const rows = ["instruction,response"];
    for (let i = 0; i < 60; i++) {
      rows.push(`Écris à user${i}@exemple.com,Voici le message ${i}`);
    }
    const report = validateDatasetFile("emails.csv", Buffer.from(rows.join("\n"), "utf8"));
    expect(report.stats.warnings.some((w) => w.includes("RGPD") || w.includes("personnelles"))).toBe(true);
    expect(report.findings.some((f) => f.code === "pii-detected")).toBe(true);
  });
});

describe("validateDatasetFile — JSONL", () => {
  it("parse les lignes et détecte les paires prompt/completion", () => {
    const jsonl = [
      JSON.stringify({ prompt: "Bonjour", completion: "Salut !" }),
      JSON.stringify({ prompt: "Au revoir", completion: "À bientôt" }),
      "",
    ].join("\n");
    const report = validateDatasetFile("pairs.jsonl", Buffer.from(jsonl, "utf8"));
    expect(report.status).toBe("valid");
    expect(report.stats.rows).toBe(2);
    expect(report.stats.pairs).toBe(1);
  });

  it("rejette un JSONL sans aucune ligne valide", () => {
    const report = validateDatasetFile("bad.jsonl", Buffer.from("{{{not-json\nalso-not-json", "utf8"));
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("no-valid-rows");
  });
});

describe("validateDatasetFile — JSON", () => {
  it("analyse un tableau d'objets", () => {
    const payload = JSON.stringify([
      { input: "Q1", output: "R1" },
      { input: "Q2", output: "R2" },
    ]);
    const report = validateDatasetFile("data.json", Buffer.from(payload, "utf8"));
    expect(report.status).toBe("valid");
    expect(report.stats.rows).toBe(2);
    expect(report.stats.columns).toEqual(["input", "output"]);
  });

  it("reconnaît les datasets pré-splittés (train/validation)", () => {
    const payload = JSON.stringify({ train: [1, 2, 3], validation: [4, 5] });
    const report = validateDatasetFile("split.json", Buffer.from(payload, "utf8"));
    expect(report.status).toBe("valid");
    expect(report.stats.rows).toBe(5);
    expect(report.findings.some((f) => f.code === "pre-split-json")).toBe(true);
  });

  it("rejette un JSON illisible", () => {
    const report = validateDatasetFile("corrupt.json", Buffer.from("{not json at all", "utf8"));
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("bad-json");
  });
});

describe("validateDatasetFile — TXT et refus", () => {
  it("compte les lignes non vides d'un corpus brut", () => {
    const report = validateDatasetFile("corpus.txt", Buffer.from("ligne 1\n\nligne 2\nligne 3\n", "utf8"));
    expect(report.status).toBe("valid");
    expect(report.stats.rows).toBe(3);
    expect(report.stats.emptyLines).toBe(1);
  });

  it("refuse une extension non supportée", () => {
    const report = validateDatasetFile("data.parquet", Buffer.from("x", "utf8"));
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("unsupported-format");
  });

  it("refuse un fichier vide", () => {
    const report = validateDatasetFile("vide.csv", Buffer.alloc(0));
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("empty-file");
  });
});

describe("auditSplits — intégrité train/validation/test", () => {
  it("signale l'absence de split d'entraînement", () => {
    const findings = auditSplits([{ id: "1", name: "a", split: "validation", rows: 10 }]);
    expect(findings.some((f) => f.code === "no-train-split")).toBe(true);
  });

  it("signale les datasets non assignés", () => {
    const findings = auditSplits([
      { id: "1", name: "a", split: "train", rows: 100 },
      { id: "2", name: "b", split: "unassigned", rows: 50 },
    ]);
    expect(findings.some((f) => f.code === "unassigned-datasets")).toBe(true);
  });

  it("avertit de l'absence de validation", () => {
    const findings = auditSplits([{ id: "1", name: "a", split: "train", rows: 100 }]);
    expect(findings.some((f) => f.code === "no-validation-split")).toBe(true);
  });

  it("ne signale rien quand la répartition est saine", () => {
    const findings = auditSplits([
      { id: "1", name: "a", split: "train", rows: 800 },
      { id: "2", name: "b", split: "validation", rows: 200 },
    ]);
    expect(findings).toHaveLength(0);
  });
});
