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
vi.mock("@/lib/tools/media/musique-chanson", () => ({
  musiqueChansonTool: {
    execute: vi.fn(),
  },
}));
vi.mock("@/lib/chat/repository", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/domain/artifacts/repository", () => ({ createArtifact: vi.fn() }));

import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { musiqueCreerTool } from "@/lib/tools/media/musique";
import { musiqueChansonTool } from "@/lib/tools/media/musique-chanson";
import { looksLikeDemandeMusique, runMusiqueTurn } from "./engine-media";

const mockedAppend = vi.mocked(appendMessage);
const mockedCreate = vi.mocked(createArtifact);
const mockedExecute = vi.mocked(musiqueCreerTool.execute);
const mockedChanson = vi.mocked(musiqueChansonTool.execute);

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
  it("CHEMIN PAR DÉFAUT (chanson) : titre + paroles + voix, audioUrl durable + artefacts", async () => {
    mockedChanson.mockResolvedValue({
      titre: "Étoiles Filantes",
      titreDetecte: true,
      paroles: { intro: ["Intro"], couplets: [["C1"]], refrain: ["Refrain un", "Refrain deux"], outro: ["Fin"], source: "moteur-gen3" },
      storage: "r2",
      url: "users/u1/permanent/musique/chansons/pop-abc-90s-192k.mp3",
      ecouterUrl: "https://www.gen3ia.online/api/media/durable?path=users%2Fu1%2Fpermanent%2Fmusique%2Fchansons%2Fpop-abc-90s-192k.mp3",
      mimeType: "audio/mpeg",
      dureeReelle: 90,
      style: "pop",
      styleLabel: "Pop",
      humeur: "joyeuse",
      chant: [{ nom: "intro", debutSec: 0, dureeVoixSec: 4.2, voix: "Intro" }],
      tailleOctets: 1_400_000,
      nomFichier: "chanson-etoles-filantes-90s.mp3",
      moteurVoix: "edge-tts-espace",
      note: "CHANSON « Étoiles Filantes » — titre CITÉ ; voix humaine réelle.",
    } as never);
    const resultat = await runMusiqueTurn(baseCtx('Crée une chanson titre : "Étoiles Filantes"') as never);
    expect(mockedChanson).toHaveBeenCalledTimes(1);
    expect(mockedExecute).not.toHaveBeenCalled();
    const appel = mockedAppend.mock.calls[0]?.[0] as { audioUrl?: string; content: string };
    expect(appel.audioUrl).toBe("/api/media/durable?path=users%2Fu1%2Fpermanent%2Fmusique%2Fchansons%2Fpop-abc-90s-192k.mp3");
    expect(appel.content).toContain("« Étoiles Filantes »");
    expect(appel.content).toContain("celui que vous avez donné");
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "audio", title: expect.stringContaining("Étoiles Filantes") }));
    expect(resultat.artifacts).toHaveLength(1);
    expect(mockedAppend.mock.calls[0]?.[0]).toHaveProperty("generationStatus", "complete");
  });

  it("DEMANDE INSTRUMENTALE explicite → l'outil historique musique.creer est utilisé", async () => {
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
    const resultat = await runMusiqueTurn(baseCtx("Crée une musique INSTRUMENTALE de 2 minutes, calme au piano") as never);
    expect(mockedExecute).toHaveBeenCalledTimes(1);
    expect(mockedChanson).not.toHaveBeenCalled();
    const appel = mockedAppend.mock.calls[0]?.[0] as { audioUrl?: string; content: string };
    expect(appel.audioUrl).toBe("/api/media/durable?path=users%2Fu1%2Fpermanent%2Fai-audio%2Fmusique-lofi-120s.mp3");
    expect(appel.content).toContain("musique instrumentale est prête");
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "audio" }));
    expect(resultat.artifacts).toHaveLength(1);
    expect(mockedAppend.mock.calls[0]?.[0]).toHaveProperty("generationStatus", "complete");
  });

  it("clip musical demandé → DEUX artefacts (audio + vidéo)", async () => {
    mockedChanson.mockResolvedValue({
      titre: "Vagues",
      titreDetecte: false,
      paroles: { intro: ["I"], couplets: [["C"]], refrain: ["R", "R"], outro: ["O"], source: "repli-deterministe" },
      storage: "r2",
      url: "users/u1/permanent/musique/chansons/lofi-abc-90s-192k.mp3",
      ecouterUrl: "https://www.gen3ia.online/api/media/durable?path=x",
      mimeType: "audio/mpeg",
      dureeReelle: 90,
      style: "lofi",
      styleLabel: "Lo-fi",
      humeur: "calme",
      chant: [],
      clip: { storage: "r2", url: "users/u1/permanent/musique/chansons/clips/abc-90s.mp4", ecouterUrl: "https://www.gen3ia.online/api/media/durable?path=y", plans: 5, tailleOctets: 4_000_000 },
      tailleOctets: 1_400_000,
      nomFichier: "chanson-vagues-90s.mp3",
      moteurVoix: "edge-tts-espace",
      note: "CHANSON + CLIP MUSICAL livré aussi.",
    } as never);
    const resultat = await runMusiqueTurn(baseCtx("crée une chanson sur la mer avec un clip musical") as never);
    expect(mockedCreate).toHaveBeenCalledTimes(2);
    expect(resultat.artifacts).toHaveLength(2);
    expect(mockedCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "video", title: expect.stringContaining("Vagues") }));
  });

  it("échec honnête : cause nommée, aucun faux succès, aucun lien mort", async () => {
    mockedChanson.mockRejectedValue(new Error("FFmpeg indisponible"));
    const resultat = await runMusiqueTurn(baseCtx("Crée une musique de 2 minutes") as never);
    const message = mockedAppend.mock.calls[0]?.[0] as { content: string; audioUrl?: string };
    expect(message.content).toContain("pas réussi");
    expect(message.content).toContain("FFmpeg indisponible");
    expect(message.audioUrl).toBeUndefined();
    expect(resultat.artifacts).toHaveLength(0);
  });
});
