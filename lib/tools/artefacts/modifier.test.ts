import { beforeEach, describe, expect, it, vi } from "vitest";

const { editerArtefactMock, editerMediaParUrlMock } = vi.hoisted(() => ({
  editerArtefactMock: vi.fn(),
  editerMediaParUrlMock: vi.fn(),
}));

vi.mock("@/lib/artefacts/edition", () => ({
  editerArtefact: editerArtefactMock,
  editerMediaParUrl: editerMediaParUrlMock,
  interpreterDemandeEdition: vi.fn(),
  operationsSupportees: vi.fn(),
}));

import { artefactModifierTool } from "./modifier";

/**
 * OUTIL ARTEFACT.MODIFIER — gen3 modifie l'image/l'audio/la vidéo créés
 * selon le prompt de l'utilisateur. Le MOTEUR réel est testé dans
 * edition.test.ts (sharp/PCM/ffmpeg réels) ; ici on vérifie le CONTRAT de
 * l'outil : artefactId → nouvelle version, url → nouvel artefact, refus
 * honnête sans cible ni sans opération reconnue.
 */
describe("artefact.modifier — le bouton « Modifier » côté gen3", () => {
  beforeEach(() => {
    editerArtefactMock.mockReset();
    editerMediaParUrlMock.mockReset();
  });

  it("artefactId + prompt → édition réelle, nouvelle VERSION enregistrée", async () => {
    editerArtefactMock.mockResolvedValue({
      artefactId: "art-1",
      type: "image",
      version: 3,
      operations: [{ nom: "rotation-droite", libelle: "Rotation 90° vers la droite" }],
      nonComprises: [],
      storagePath: "users/u1/permanent/artefacts-edites/1.png",
      note: "Édition gen3 (« pivoter à droite ») : Rotation 90°.",
    });
    const resultat = await artefactModifierTool.execute(
      { artefactId: "art-1", prompt: "pivoter à droite" },
      { userId: "u1" },
    );
    expect(editerArtefactMock).toHaveBeenCalledWith({ userId: "u1", artefactId: "art-1", prompt: "pivoter à droite" });
    expect(resultat.ok).toBe(true);
    expect(resultat.version).toBe(3);
    expect(resultat.details).toMatch(/Version 3 enregistrée/);
  });

  it("url + type → éditer un média du fil crée un NOUVEL artefact propriétaire", async () => {
    editerMediaParUrlMock.mockResolvedValue({
      artefactId: "art-nouveau",
      artefactCree: "art-nouveau",
      type: "audio",
      version: 1,
      operations: [{ nom: "volume:30", libelle: "Volume ajusté (+30 %)" }],
      nonComprises: [],
      storagePath: "users/u1/permanent/artefacts-edites/2.wav",
      note: "Édition gen3 (« plus fort ») : Volume ajusté (+30 %).",
    });
    const resultat = await artefactModifierTool.execute(
      { url: "https://exemple.com/audio.wav", type: "audio", prompt: "plus fort" },
      { userId: "u1" },
    );
    expect(editerMediaParUrlMock).toHaveBeenCalled();
    expect(resultat.ok).toBe(true);
    expect(resultat.artefactId).toBe("art-nouveau");
    expect(resultat.details).toMatch(/Nouvel artefact/);
  });

  it("sans artefactId ni url → refus honnête (pas d'édition floue)", async () => {
    const resultat = await artefactModifierTool.execute({ prompt: "modifie ça" }, { userId: "u1" });
    expect(resultat.ok).toBe(false);
    expect(resultat.details).toMatch(/Fournir `artefactId`|Fournir artefactId|artefactId.*url/s);
  });

  it("prompt sans opération reconnue → l'erreur honnête du moteur est propagée", async () => {
    editerArtefactMock.mockRejectedValue(
      new Error("Aucune opération d'édition reconnue dans « change le ciel en licornes ». Opérations supportées (image) : rotation…"),
    );
    await expect(
      artefactModifierTool.execute({ artefactId: "art-1", prompt: "change le ciel en licornes" }, { userId: "u1" }),
    ).rejects.toThrow(/Aucune opération d'édition reconnue/);
  });
});
