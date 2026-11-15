import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Route admin d'entraînement web-dev : garde admin stricte sur les deux
 * verbes, délégation réelle à l'orchestrateur (mocké ici — la chaîne
 * d'entraînement réelle est couverte par webdev.test.ts), rapport honnête.
 */

const requireAdminMock = vi.fn();
const entrainerMock = vi.fn();
const lireRapportMock = vi.fn();

vi.mock("@/lib/security/admin-access", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...(args as [])),
}));

vi.mock("@/lib/security/http-errors", () => ({
  errorBody: (error: unknown, repli: string) => ({ error: error instanceof Error ? error.message : repli }),
  errorStatus: () => 403,
}));

vi.mock("@/lib/neural/training/entrainement-webdev", () => ({
  entrainerDeveloppementWeb: (...args: unknown[]) => entrainerMock(...(args as [])),
  lireRapportWebdev: (...args: unknown[]) => lireRapportMock(...(args as [])),
}));

import { GET, POST } from "./route";

function requete(corps?: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/admin/entrainement/webdev", {
    method: "POST",
    body: corps ? JSON.stringify(corps) : undefined,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requireAdminMock.mockReset();
  entrainerMock.mockReset();
  lireRapportMock.mockReset();
});

describe("POST /api/admin/entrainement/webdev", () => {
  it("refuse un non-admin (403, aucun entraînement lancé)", async () => {
    requireAdminMock.mockRejectedValue(new Error("Administrator access required."));
    const reponse = await POST(requete({}));
    expect(reponse.status).toBe(403);
    expect(entrainerMock).not.toHaveBeenCalled();
  });

  it("lance l'entraînement avec les plafonds par défaut et retourne le rapport", async () => {
    requireAdminMock.mockResolvedValue({ uid: "admin-1" });
    entrainerMock.mockResolvedValue({
      statut: "termine",
      message: "Web-dev : entraînement effectué",
      snn: { echantillons: 2000, epoques: 3, accuracyTrain: 0.9, accuracyTest: 0.8, dureeMs: 1 },
      cortex: { pairesAjoutees: 60000, doublons: 0, vocabulaire: 1000, totalPaires: 60000, pairesProposees: 60000, retention: { accuracy: 0.5, unites: 150 } },
      couverture: { parTache: {}, parLangue: {}, tokensDistincts: 1 },
      cerveauSauvegarde: true,
      dureeMs: 1,
      v: 1,
      dateA: new Date().toISOString(),
      source: "training/gen3-domain-datasets/data/complet/developpement_web.jsonl.gz",
      lignesLues: 100000,
    });
    const reponse = await POST(requete({}));
    expect(reponse.status).toBe(200);
    const body = (await reponse.json()) as { ok: boolean; statut: string };
    expect(body.ok).toBe(true);
    expect(body.statut).toBe("termine");
    // Plafonds de production transmis (régime équilibré : SNN 2k / cortex 60k / 3 époques).
    expect(entrainerMock).toHaveBeenCalledWith({
      plafondSnn: undefined,
      plafondCortex: undefined,
      epoques: undefined,
    });
  });

  it("retourne 503 quand l'entraînement échoue (statut echec)", async () => {
    requireAdminMock.mockResolvedValue({ uid: "admin-1" });
    entrainerMock.mockResolvedValue({
      statut: "echec",
      message: "Aucune donnée web-dev disponible",
      snn: null,
      cortex: null,
      couverture: { parTache: {}, parLangue: {}, tokensDistincts: 0 },
      cerveauSauvegarde: false,
      dureeMs: 1,
      v: 1,
      dateA: new Date().toISOString(),
      source: "",
      lignesLues: 0,
    });
    const reponse = await POST(requete({}));
    expect(reponse.status).toBe(503);
  });
});

describe("GET /api/admin/entrainement/webdev", () => {
  it("refuse un non-admin (403)", async () => {
    requireAdminMock.mockRejectedValue(new Error("Administrator access required."));
    const reponse = await GET(new NextRequest("https://gen3ia.local/api/admin/entrainement/webdev"));
    expect(reponse.status).toBe(403);
  });

  it("renvoie le dernier rapport persisté (ok:false si aucun)", async () => {
    requireAdminMock.mockResolvedValue({ uid: "admin-1" });
    lireRapportMock.mockResolvedValue(null);
    const reponse = await GET(new NextRequest("https://gen3ia.local/api/admin/entrainement/webdev"));
    const body = (await reponse.json()) as { ok: boolean; rapport: unknown };
    expect(body.ok).toBe(false);
    expect(body.rapport).toBeNull();
  });
});
