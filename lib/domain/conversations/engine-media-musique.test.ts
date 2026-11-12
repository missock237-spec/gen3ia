import { describe, expect, it, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/* TOUR MUSIQUE — détection déterministe + livraison RÉELLE dans le    */
/* fil (lecteur audio durable). Le tool musique.creer est mocké (testé */
/* de bout en bout ailleurs) ; la CONTRAT du tour est vérifié ici :    */
/* message avec audioUrl structuré + artefact audio + échec honnête.   */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/tools/media/musique", () => ({
  musiqueCreerTool: {
    execute: vi.fn(),
  },
}));
vi.mock("@/lib/chat/repository", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/domain/artifacts/repository", () => ({ createArtifact: vi.fn() }));

import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { musiqueCreerTool } from "@/lib/tools/media/musique";
import { looksLikeDemandeMusique, runMusiqueTurn } from "./engine-media";

const mockedAppend = vi.mocked(appendMessage);
const mockedCreate = vi.mocked(createArtifact);
const mockedExecute = vi.mocked(musiqueCreerTool.execute);

function baseCtx(message: string) {
  return {
    userId: "u1",
    conversationId: "c1",
    projectId: undefined,
    message,
    userMessage: { id: "m1", role: "user" as const, content: message },
    priorHistory: [],
    onEvent: vi.fn(),
    origineClient: "https://www.gen3ia.online",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAppend.mockResolvedValue({ id: "a1", role: "assistant", content: "x" } as never);
  mockedCreate.mockResolvedValue({ id: "art1", type: "audio" } as never);
});

describe("looksLikeDemandeMusique — détection déterministe", () => {
  const positifs = [
    "Crée une musique de 2 minutes : instrumentale calme au piano.",
    "compose une mélodie joyeuse",
    "génère une musique énergique pour mon intro",
    "fais-moi une chanson relaxante de 90 secondes",
    "Crée une musique de 120 s au piano",
  ];
  for (const m of positifs) {
    it(`positif : « ${m.slice(0, 40)} »`, () => {
      expect(looksLikeDemandeMusique(m)).toBe(true);
    });
  }
  const negatifs = [
    "Crée une vidéo avec une musique énergique", // vidéo d'abord
    "Crée un message vocal d'une femme qui se présente", // voix parlée
    "Quelle musique écouter en travaillant ?", // question méta, aucun produit
    "C'est quoi une nappe sonore ?", // pure question méta
    "Résume ce texte en 3 points", // aucun objet musical
  ];
  for (const m of negatifs) {
    it(`négatif : « ${m.slice(0, 40)} »`, () => {
      expect(looksLikeDemandeMusique(m)).toBe(false);
    });
  }
});

describe("runMusiqueTurn — livraison dans le fil", () => {
  it("succès : message avec audioUrl durable + artefact audio + événements", async () => {
    mockedExecute.mockResolvedValue({
      url: "users/u1/permanent/ai-audio/musique-lofi-120s.mp3",
      storage: "r2",
      ecouterUrl: "https://www.gen3ia.online/api/media/durable?path=users%2Fu1%2Fpermanent%2Fai-audio%2Fmusique-lofi-120s.mp3",
      mimeType: "audio/mpeg",
      dureeReelle: 120,
      style: "lofi",
      styleLabel: "Lo-fi détente",
      humeur: "calme",
      note: "VRAIE MUSIQUE composée ALGORITHMIQUEMENT.",
    } as never);
    const resultat = await runMusiqueTurn(baseCtx("Crée une musique de 2 minutes, calme au piano") as never);
    expect(mockedExecute).toHaveBeenCalledTimes(1);
    const appel = mockedAppend.mock.calls[0]?.[0] as { audioUrl?: string; content: string };
    expect(appel.audioUrl).toBe("/api/media/durable?path=users%2Fu1%2Fpermanent%2Fai-audio%2Fmusique-lofi-120s.mp3");
    expect(appel.content).toContain("musique est prête");
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "audio" }));
    expect(resultat.artifacts).toHaveLength(1);
    expect(mockedAppend.mock.calls[0]?.[0]).toHaveProperty("generationStatus", "complete");
  });

  it("échec honnête : cause nommée, aucun faux succès, aucun lien mort", async () => {
    mockedExecute.mockRejectedValue(new Error("FFmpeg indisponible"));
    const resultat = await runMusiqueTurn(baseCtx("Crée une musique de 2 minutes") as never);
    const message = mockedAppend.mock.calls[0]?.[0] as { content: string; audioUrl?: string };
    expect(message.content).toContain("pas réussi");
    expect(message.content).toContain("FFmpeg indisponible");
    expect(message.audioUrl).toBeUndefined();
    expect(resultat.artifacts).toHaveLength(0);
  });
});
