import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requireUserMock, getArtifactMock, downloadFromR2Mock, editerArtefactMock, editerMediaParUrlMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(),
  getArtifactMock: vi.fn(),
  downloadFromR2Mock: vi.fn(),
  editerArtefactMock: vi.fn(),
  editerMediaParUrlMock: vi.fn(),
}));

vi.mock("@/lib/security/authenticated-request", () => ({
  requireUser: requireUserMock,
}));
vi.mock("@/lib/domain/artifacts/repository", () => ({
  getArtifact: getArtifactMock,
}));
vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: downloadFromR2Mock,
}));
vi.mock("@/lib/artefacts/edition", () => ({
  editerArtefact: editerArtefactMock,
  editerMediaParUrl: editerMediaParUrlMock,
}));

import { POST as POSTModifier } from "@/app/api/artefacts/modifier/route";
import { GET as GETTelecharger } from "@/app/api/artefacts/[artefactId]/telecharger/route";

/** Faux PNG (magic bytes réels + corps quelconque) pour le sniffer de type. */
function fauxPng(): Buffer {
  const entete = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([entete, Buffer.alloc(64, 7)]);
}

const utilisateur = { uid: "u1", email: "u1@exemple.fr" };

/**
 * ROUTES ARTEFACTS — le BOUTON « Modifier » (POST /api/artefacts/modifier)
 * et le TÉLÉCHARGEMENT par chaque utilisateur de ce que gen3 a créé
 * (GET /api/artefacts/[id]/telecharger, content-disposition attachment,
 * propriété stricte). Auth + mocks des moteurs réels (testés ailleurs).
 */
describe("route /api/artefacts/modifier — le bouton Modifier", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(utilisateur);
    editerArtefactMock.mockReset();
    editerMediaParUrlMock.mockReset();
  });

  it("artefactId + prompt → 200 avec la nouvelle version", async () => {
    editerArtefactMock.mockResolvedValue({
      artefactId: "art-1",
      type: "image",
      version: 2,
      operations: [{ nom: "gris", libelle: "Noir et blanc" }],
      nonComprises: [],
      storagePath: "users/u1/permanent/artefacts-edites/9.png",
      note: "Édition gen3 (« noir et blanc ») : Noir et blanc.",
    });
    const requete = new NextRequest("http://localhost/api/artefacts/modifier", {
      method: "POST",
      body: JSON.stringify({ artefactId: "art-1", prompt: "noir et blanc" }),
      headers: { "content-type": "application/json" },
    });
    const reponse = await POSTModifier(requete);
    expect(reponse.status).toBe(200);
    const corps = (await reponse.json()) as { ok: boolean; version: number; details: string };
    expect(corps.ok).toBe(true);
    expect(corps.version).toBe(2);
    expect(corps.details).toMatch(/Noir et blanc/);
  });

  it("prompt non reconnu → 400 honnête avec les opérations supportées", async () => {
    editerArtefactMock.mockRejectedValue(
      new Error("Aucune opération d'édition reconnue dans « xyz ». Opérations supportées (image) : rotation…"),
    );
    const requete = new NextRequest("http://localhost/api/artefacts/modifier", {
      method: "POST",
      body: JSON.stringify({ artefactId: "art-1", prompt: "xyz" }),
      headers: { "content-type": "application/json" },
    });
    const reponse = await POSTModifier(requete);
    expect(reponse.status).toBe(400);
    const corps = (await reponse.json()) as { error?: { message?: string }; message?: string };
    expect(JSON.stringify(corps)).toMatch(/Aucune opération d'édition reconnue/);
  });

  it("sans authentification → refus du garde requireUser", async () => {
    requireUserMock.mockRejectedValue(new Error("AUTH_REQUIRED"));
    const requete = new NextRequest("http://localhost/api/artefacts/modifier", {
      method: "POST",
      body: JSON.stringify({ artefactId: "art-1", prompt: "pivoter" }),
      headers: { "content-type": "application/json" },
    });
    const reponse = await POSTModifier(requete);
    expect(reponse.status).toBeGreaterThanOrEqual(400);
  });
});

describe("route /api/artefacts/[id]/telecharger — chaque utilisateur télécharge ses artefacts", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(utilisateur);
    getArtifactMock.mockReset();
    downloadFromR2Mock.mockReset();
  });

  it("artefact image avec fichier stocké → 200 attachment (téléchargement forcé)", async () => {
    const buffer = fauxPng();
    getArtifactMock.mockResolvedValue({
      id: "art-1",
      userId: "u1",
      type: "image",
      title: "Image générée",
      filename: "image.png",
      storagePath: "users/u1/permanent/ai-images/1.png",
      versions: [],
    });
    downloadFromR2Mock.mockResolvedValue(buffer);
    const requete = new NextRequest("http://localhost/api/artefacts/art-1/telecharger");
    const reponse = await GETTelecharger(requete, { params: Promise.resolve({ artefactId: "art-1" }) });
    expect(reponse.status).toBe(200);
    expect(reponse.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(reponse.headers.get("content-type")).toMatch(/image\/png/);
    const corps = Buffer.from(await reponse.arrayBuffer());
    expect(corps.length).toBe(buffer.length);
    expect(downloadFromR2Mock).toHaveBeenCalledWith("users/u1/permanent/ai-images/1.png", expect.any(Number));
  });

  it("artefact d'un AUTRE compte → 404 (propriété stricte, invisible)", async () => {
    getArtifactMock.mockResolvedValue(null);
    const requete = new NextRequest("http://localhost/api/artefacts/art-2/telecharger");
    const reponse = await GETTelecharger(requete, { params: Promise.resolve({ artefactId: "art-2" }) });
    expect(reponse.status).toBe(404);
    expect(downloadFromR2Mock).not.toHaveBeenCalled();
  });

  it("artefact textuel (code, document) → téléchargé tel quel en texte", async () => {
    getArtifactMock.mockResolvedValue({
      id: "art-3",
      userId: "u1",
      type: "code",
      title: "Rapport gen3",
      content: "console.log('gen3');",
      versions: [],
    });
    const requete = new NextRequest("http://localhost/api/artefacts/art-3/telecharger");
    const reponse = await GETTelecharger(requete, { params: Promise.resolve({ artefactId: "art-3" }) });
    expect(reponse.status).toBe(200);
    expect(reponse.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await reponse.text()).toBe("console.log('gen3');");
  });

  it("vidéo de production en cours → redirection honnête vers le studio (pas de faux fichier)", async () => {
    getArtifactMock.mockResolvedValue({
      id: "art-4",
      userId: "u1",
      type: "video",
      title: "Vidéo autopilote",
      videoProjectId: "vp-9",
      versions: [],
    });
    const requete = new NextRequest("http://localhost/api/artefacts/art-4/telecharger");
    const reponse = await GETTelecharger(requete, { params: Promise.resolve({ artefactId: "art-4" }) });
    expect(reponse.status).toBe(200);
    const corps = (await reponse.json()) as { ok: boolean; message: string };
    expect(corps.ok).toBe(false);
    expect(corps.message).toMatch(/studio vidéo/);
  });

  it("aperçu inline : `?apercu=1` sert le média pour l'affichage (pas d'attachment)", async () => {
    getArtifactMock.mockResolvedValue({
      id: "art-5",
      userId: "u1",
      type: "image",
      title: "Image éditée",
      storagePath: "users/u1/permanent/artefacts-edites/5.png",
      versions: [],
    });
    downloadFromR2Mock.mockResolvedValue(fauxPng());
    const requete = new NextRequest("http://localhost/api/artefacts/art-5/telecharger?apercu=1");
    const reponse = await GETTelecharger(requete, { params: Promise.resolve({ artefactId: "art-5" }) });
    expect(reponse.status).toBe(200);
    expect(reponse.headers.get("content-disposition")).toMatch(/^inline;/);
  });
});
