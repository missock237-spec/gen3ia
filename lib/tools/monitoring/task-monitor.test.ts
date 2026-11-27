/**
 * Tests — OUTIL « task.monitor » (état réel des tâches d'entraînement).
 *
 * Les frontières (job neuronal, état auto-apprentissage) sont mockées à CE
 * niveau : l'outil reste le sujet (lecture, mise en forme, messages FR).
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobEnCours: vi.fn(),
  getDernierJob: vi.fn(),
  lireEtatAuto: vi.fn(),
}));

vi.mock("@/lib/neural/training/job", () => ({
  getJobEnCours: (...args: unknown[]) => mocks.getJobEnCours(...args),
  getDernierJob: (...args: unknown[]) => mocks.getDernierJob(...args),
}));

vi.mock("@/lib/entrainement-auto/etat", () => ({
  lireEtatAuto: (...args: unknown[]) => mocks.lireEtatAuto(...args),
}));

import { taskMonitorTool } from "./task-monitor";

describe("task.monitor — lecture honnête de l'état réel", () => {
  it("déclare 'aucun' quand aucun job n'existe (jamais de donnée inventée)", async () => {
    mocks.getJobEnCours.mockReturnValue(null);
    mocks.getDernierJob.mockReturnValue(null);
    mocks.lireEtatAuto.mockResolvedValue({
      regime: "maitrise",
      cyclesExecutes: 12,
      enCours: false,
      datasetsIngestes: ["hf:exemple/1"],
      maitrise: { domaines: { vente: { maitriseA: "2026-11-27T00:00:00Z" } } },
      historique: [],
    });

    const resultat = await taskMonitorTool.execute({ inclureHistorique: false }, { userId: "u1" });
    expect(resultat.entrainement.statut).toBe("aucun");
    expect(resultat.entrainement.source).toBeUndefined();
    expect(resultat.autoApprentissage.regime).toBe("maitrise");
    expect(resultat.autoApprentissage.cyclesExecutes).toBe(12);
    expect(resultat.autoApprentissage.domainesMaitrises).toEqual(["vente"]);
    expect(resultat.messages.some((m) => m.includes("Aucun job"))).toBe(true);
  });

  it("expose la progression réelle d'un job en cours", async () => {
    mocks.getJobEnCours.mockReturnValue({
      id: "job-1",
      status: "en_cours",
      source: "complet",
      demarreLe: "2026-11-27T10:00:00Z",
      epochs: 4,
      epochCourante: 2,
      nbEchantillons: 1200,
      accuracyCourante: 0.72,
    });
    mocks.getDernierJob.mockReturnValue(null);
    mocks.lireEtatAuto.mockResolvedValue(null);

    const resultat = await taskMonitorTool.execute({ inclureHistorique: false }, { userId: "u1" });
    expect(resultat.entrainement.statut).toBe("en_cours");
    expect(resultat.entrainement.epochCourante).toBe(2);
    expect(resultat.entrainement.epochs).toBe(4);
    expect(resultat.messages.some((m) => m.includes("en cours (2/4 époques)"))).toBe(true);
    expect(resultat.autoApprentissage.regime).toBe("inconnu");
  });

  it("renvoie le dernier rapport terminé sur demande (inclureHistorique)", async () => {
    mocks.getJobEnCours.mockReturnValue(null);
    mocks.getDernierJob.mockReturnValue({
      id: "job-0",
      status: "termine",
      demarreLe: "2026-11-26T09:00:00Z",
      termineLe: "2026-11-26T09:12:00Z",
      epochs: 3,
      rapport: { epochs: 3, samples: 800, accuracyTrain: 0.9, accuracyTest: 0.82, dureeMs: 720000, history: [] },
    });
    mocks.lireEtatAuto.mockResolvedValue(null);

    const resultat = await taskMonitorTool.execute({ inclureHistorique: true }, { userId: "u1" });
    expect(resultat.entrainement.statut).toBe("termine");
    expect(resultat.entrainement.dernierRapport).toEqual({
      epochs: 3,
      samples: 800,
      accuracyTrain: 0.9,
      accuracyTest: 0.82,
      dureeMs: 720000,
    });
  });

  it("survit à une erreur de lecture d'état (état inconnu, message honnête)", async () => {
    mocks.getJobEnCours.mockReturnValue(null);
    mocks.getDernierJob.mockReturnValue(null);
    mocks.lireEtatAuto.mockRejectedValue(new Error("lecture impossible"));

    const resultat = await taskMonitorTool.execute({ inclureHistorique: false }, { userId: "u1" });
    expect(resultat.autoApprentissage.regime).toBe("inconnu");
    expect(resultat.autoApprentissage.cyclesExecutes).toBe(0);
    expect(resultat.messages.length).toBeGreaterThan(0);
  });
});
