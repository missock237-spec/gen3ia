import { afterEach, describe, expect, it } from "vitest";

import { assertUploadSize, trainingQuotas } from "./quotas";
import { canTransition } from "./orchestrator";
import { validatePlanAgainstEngine } from "./engines/registry";

/* ------------------------------------------------------------------ */
/* Quotas + machine à états + cohérence moteur — règles serveur.       */
/* ------------------------------------------------------------------ */

afterEach(() => {
  delete process.env.TRAINING_MAX_UPLOAD_MB;
});

describe("trainingQuotas", () => {
  it("applique les valeurs par défaut prudentes", () => {
    const quotas = trainingQuotas();
    expect(quotas.maxProjects).toBe(10);
    expect(quotas.maxConcurrentJobs).toBe(1);
    expect(quotas.maxUploadBytes).toBe(200 * 1024 * 1024);
    expect(quotas.maxDatasetsPerProject).toBe(50);
  });

  it("respecte les variables d'environnement", () => {
    process.env.TRAINING_MAX_UPLOAD_MB = "5";
    const quotas = trainingQuotas();
    expect(quotas.maxUploadBytes).toBe(5 * 1024 * 1024);
  });
});

describe("assertUploadSize", () => {
  it("refuse un fichier dépassant la limite", () => {
    process.env.TRAINING_MAX_UPLOAD_MB = "1";
    expect(() => assertUploadSize(2 * 1024 * 1024, "Modèle")).toThrow(/trop volumineux/i);
  });

  it("accepte un fichier dans la limite", () => {
    process.env.TRAINING_MAX_UPLOAD_MB = "1";
    expect(() => assertUploadSize(512 * 1024)).not.toThrow();
  });
});

describe("canTransition — machine à états des jobs", () => {
  it("autorise queued → running et running → completed", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
  });

  it("refuse completed → running (aucune résurrection silencieuse)", () => {
    expect(canTransition("completed", "running")).toBe(false);
  });

  it("autorise failed → queued (relance après échec)", () => {
    expect(canTransition("failed", "queued")).toBe(true);
  });

  it("refuse cancelled → running", () => {
    expect(canTransition("cancelled", "running")).toBe(false);
  });

  it("autorise l'annulation depuis queued et running", () => {
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
  });
});

describe("validatePlanAgainstEngine — capacités déclarées", () => {
  it("accepte un plan LoRA cohérent", () => {
    const errors = validatePlanAgainstEngine({
      method: "lora",
      engineId: "text-lora",
      parameters: { learningRate: 0.0002, epochs: 3, loraRank: 16 },
    });
    expect(errors).toHaveLength(0);
  });

  it("refuse une méthode non supportée par le moteur", () => {
    const errors = validatePlanAgainstEngine({
      method: "rag",
      engineId: "text-lora",
      parameters: {},
    });
    expect(errors.some((e) => e.includes("pas supportée"))).toBe(true);
  });

  it("refuse un paramètre hors bornes", () => {
    const errors = validatePlanAgainstEngine({
      method: "lora",
      engineId: "text-lora",
      parameters: { epochs: 500 },
    });
    expect(errors.some((e) => e.includes("Époques"))).toBe(true);
  });

  it("refuse un paramètre inconnu du moteur", () => {
    const errors = validatePlanAgainstEngine({
      method: "lora",
      engineId: "text-lora",
      parameters: { superParam: 1 },
    });
    expect(errors.some((e) => e.includes("inconnu"))).toBe(true);
  });

  it("refuse un moteur inexistant", () => {
    const errors = validatePlanAgainstEngine({ method: "lora", engineId: "moteur-fantôme", parameters: {} });
    expect(errors).toHaveLength(1);
  });
});
