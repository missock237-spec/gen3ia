import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/* ROUTE D'ENTRAÎNEMENT DU STUDIO — contrat de la surface HTTP :        */
/*  - authentification obligatoire (401 sans session) ;                 */
/*  - 404 projet hors du compte (anti-énumération) ;                    */
/*  - 400 requête invalide / sans ressource ;                           */
/*  - 201 avec rapport + fichier final quand le pipeline réussit ;      */
/*  - 422 avec le CODE d'échec honnête quand le pipeline refuse         */
/*    (aucun gain mesuré, aucune unité, régression hors domaine).       */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/training/repository", () => ({
  getProject: vi.fn(),
  getDataset: vi.fn(),
}));
vi.mock("@/lib/training/audit", () => ({
  ipFromRequest: vi.fn(() => "127.0.0.1"),
  recordTrainingAudit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: vi.fn(),
}));

/** Le pipeline est MOCKÉ (testé de bout en bout ailleurs) — mais la CLASSE
 * d'erreur doit être réelle pour que la route la reconnaisse (instanceof). */
vi.mock("@/lib/studio/pipeline-entrainement", () => ({
  ErreurEntrainementStudio: class ErreurEntrainementStudio extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ErreurEntrainementStudio";
      this.code = code;
    }
  },
  executerEntrainementStudio: vi.fn(),
  lireRapportEntrainement: vi.fn(),
  telechargerRessourceUrl: vi.fn(),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getProject, getDataset } from "@/lib/training/repository";
import { downloadFromR2 } from "@/lib/storage/r2";
import {
  executerEntrainementStudio,
  lireRapportEntrainement,
} from "@/lib/studio/pipeline-entrainement";

import { GET as entrainementGET, POST as entrainementPOST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedLimit = vi.mocked(enforceRateLimit);
const mockedGetProject = vi.mocked(getProject);
const mockedGetDataset = vi.mocked(getDataset);
const mockedDownload = vi.mocked(downloadFromR2);
const mockedExecuter = vi.mocked(executerEntrainementStudio);
const mockedLireRapport = vi.mocked(lireRapportEntrainement);

const PROJET = { id: "01JPROJET0000000000000000", name: "Botanique Gen3" };

function requetePost(corps: unknown): { request: NextRequest; params: Promise<{ id: string }> } {
  return {
    request: new NextRequest("http://localhost/api/training/projects/01JPROJET0000000000000000/entrainement", {
      method: "POST",
      body: JSON.stringify(corps),
      headers: { "content-type": "application/json" },
    }),
    params: Promise.resolve({ id: PROJET.id }),
  };
}

function requeteGet(): { request: NextRequest; params: Promise<{ id: string }> } {
  return {
    request: new NextRequest("http://localhost/api/training/projects/01JPROJET0000000000000000/entrainement"),
    params: Promise.resolve({ id: PROJET.id }),
  };
}

function reponseReussie() {
  return {
    rapport: {
      v: 1,
      projetId: PROJET.id,
      projetNom: PROJET.name,
      domaine: "botanique",
      lanceLe: new Date().toISOString(),
      ressources: [],
      corpus: { unites: 6, parType: { qa: 3, fait: 2, code: 1 }, octets: 900, elements: 6, ignores: 0, doublons: 0 },
      evaluation: {
        domaine: { questions: 6 },
        avant: { questions: 6, servies: 0, couverture: 0, correspondanceServie: 0, scoreGlobal: 0 },
        apres: { questions: 6, servies: 6, couverture: 1, correspondanceServie: 1, scoreGlobal: 1 },
        amelioration: 1,
        horsDomaine: { questions: 6, serviesAvant: 0, serviesApres: 0, regression: false },
      },
      memoire: { cleStockage: "users/u1/studio/memoire/botanique.json", unitesAjoutees: 6, doublons: 0, refuseesCap: 0, totalUnites: 6, octetsUnites: 900 },
      fichierFinal: {
        nom: "gen3iac-entrainement-botanique-gen3-test.json",
        cle: "users/u1/permanent/studio/gen3iac-entrainement-botanique-gen3-test.json",
        taille: 2048,
        lienDurable: "/api/media/durable?path=users%2Fu1%2Fpermanent%2Fstudio%2Fgen3iac-entrainement-botanique-gen3-test.json",
        packSha256: "a".repeat(64),
      },
    },
    fichier: {
      nom: "gen3iac-entrainement-botanique-gen3-test.json",
      cle: "users/u1/permanent/studio/gen3iac-entrainement-botanique-gen3-test.json",
      taille: 2048,
      lienDurable: "/api/media/durable?path=users%2Fu1%2Fpermanent%2Fstudio%2Fgen3iac-entrainement-botanique-gen3-test.json",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLimit.mockResolvedValue({ allowed: true, remaining: 5, resetMs: 600_000 } as never);
  mockedGetProject.mockResolvedValue(PROJET as never);
});

describe("POST /api/training/projects/[id]/entrainement", () => {
  it("401 sans session authentifiée", async () => {
    mockedRequireUser.mockRejectedValue(new Error("unauthenticated"));
    const { request, params } = requetePost({ domaine: "botanique", textes: [{ titre: "fiche", contenu: "Q: Une question sur le domaine ?\nA: Une réponse suffisamment longue pour compter.\n" }] });
    const reponse = await entrainementPOST(request, { params });
    expect(reponse.status).toBe(500);
  });

  it("404 quand le projet n'appartient pas au compte (anti-énumération)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u1" } as never);
    mockedGetProject.mockResolvedValue(null as never);
    const { request, params } = requetePost({ domaine: "botanique", textes: [{ titre: "fiche", contenu: "Q: Une question sur le domaine ?\nA: Une réponse suffisamment longue pour compter.\n" }] });
    const reponse = await entrainementPOST(request, { params });
    expect(reponse.status).toBe(404);
    const corps = (await reponse.json()) as { error: string };
    expect(corps.error).toContain("introuvable");
  });

  it("400 sur une requête invalide ou sans ressources", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u1" } as never);
    const invalide = await entrainementPOST(
      requetePost({ domaine: "" }).request,
      { params: requetePost({}).params },
    );
    expect(invalide.status).toBe(400);

    const vide = await entrainementPOST(
      requetePost({ domaine: "botanique" }).request,
      { params: requetePost({}).params },
    );
    expect(vide.status).toBe(400);
    const corps = (await vide.json()) as { error: string };
    expect(corps.error).toContain("Aucune ressource");
  });

  it("201 avec rapport + fichier final + ressources défaillantes expliquées", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u1" } as never);
    // Un dataset valide chargé du stockage + une URL défaillante (mockée).
    mockedGetDataset.mockResolvedValue({
      id: "ds1",
      projectId: PROJET.id,
      name: "cours-botanique.json",
      format: "json",
      storageKey: "users/u1/training-files/x/ds1",
      status: "valid",
    } as never);
    mockedDownload.mockResolvedValue(Buffer.from(JSON.stringify([
      { question: "Quelle plante fixe l'azote ?", response: "Les légumineuses, via leurs nodosités symbiotiques." },
    ])) as never);
    const { telechargerRessourceUrl } = await import("@/lib/studio/pipeline-entrainement");
    vi.mocked(telechargerRessourceUrl).mockRejectedValue(new Error("URL injoignable"));
    mockedExecuter.mockResolvedValue(reponseReussie() as never);

    const { request, params } = requetePost({
      domaine: "botanique",
      textes: [{ titre: "Fiche", contenu: "Q: Qu'est-ce que la photosynthèse ?\nA: Le processus par lequel les plantes vertes transforment la lumière en énergie chimique.\n" }],
      datasetIds: ["ds1"],
      urls: ["https://exemple.fr/plantes"],
    });
    const reponse = await entrainementPOST(request, { params });
    expect(reponse.status).toBe(201);
    const corps = (await reponse.json()) as {
      rapport: { evaluation: { apres: { scoreGlobal: number }, avant: { scoreGlobal: number } } };
      fichier: { lienDurable: string };
      defaillances: string[];
    };
    expect(corps.rapport.evaluation.apres.scoreGlobal).toBeGreaterThan(corps.rapport.evaluation.avant.scoreGlobal);
    expect(corps.fichier.lienDurable).toContain("/api/media/durable?path=");
    expect(corps.defaillances[0]).toContain("URL");
    // Le pipeline a bien reçu les 2 ressources chargées (texte + dataset).
    expect(mockedExecuter).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        domaine: "botanique",
        ressources: expect.arrayContaining([
          expect.objectContaining({ origine: "texte" }),
          expect.objectContaining({ origine: "dataset", titre: "cours-botanique.json" }),
        ]),
      }),
    );
  });

  it("422 avec le code d'échec honnête quand le pipeline refuse", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u1" } as never);
    const { ErreurEntrainementStudio } = await import("@/lib/studio/pipeline-entrainement");
    mockedExecuter.mockRejectedValue(
      new ErreurEntrainementStudio("aucun-gain-mesure", "Aucun gain mesurable sur le domaine."),
    );
    const { request, params } = requetePost({
      domaine: "botanique",
      textes: [{ titre: "Fiche", contenu: "Q: Qu'est-ce que la photosynthèse ?\nA: Le processus par lequel les plantes vertes transforment la lumière en énergie chimique.\n" }],
    });
    const reponse = await entrainementPOST(request, { params });
    expect(reponse.status).toBe(422);
    const corps = (await reponse.json()) as { code: string; error: string };
    expect(corps.code).toBe("aucun-gain-mesure");
    expect(corps.error).toContain("gain");
  });
});

describe("GET /api/training/projects/[id]/entrainement", () => {
  it("404 sans projet ou sans entraînement lancé", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u1" } as never);
    mockedGetProject.mockResolvedValue(null as never);
    const sansProjet = await entrainementGET(requeteGet().request, { params: requeteGet().params });
    expect(sansProjet.status).toBe(404);

    mockedGetProject.mockResolvedValue(PROJET as never);
    mockedLireRapport.mockResolvedValue(null as never);
    const jamaisLance = await entrainementGET(requeteGet().request, { params: requeteGet().params });
    expect(jamaisLance.status).toBe(404);
    const corps = (await jamaisLance.json()) as { error: string };
    expect(corps.error).toContain("Aucun entraînement");
  });

  it("200 avec le dernier rapport du projet", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u1" } as never);
    const reussie = reponseReussie();
    mockedLireRapport.mockResolvedValue(reussie.rapport as never);
    const reponse = await entrainementGET(requeteGet().request, { params: requeteGet().params });
    expect(reponse.status).toBe(200);
    const corps = (await reponse.json()) as { rapport: { domaine: string } };
    expect(corps.rapport.domaine).toBe("botanique");
  });
});
