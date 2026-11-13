import { describe, expect, it, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/* TOUR SON — détection déterministe + livraison RÉELLE dans le fil    */
/* (lecteur audio durable). Le tool voice.speak est mocké (testé de    */
/* bout en bout ailleurs) ; le CONTRAT du tour est vérifié ici :       */
/* message avec audioUrl structuré + artefact audio + échec honnête.   */
/* Production (sonde 2026-11-13) : « crée le son de la pluie » tombait */
/* dans le compartiment sciences — ce tour garantit le rendu SONORE.   */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/tools/media/voice-speak", () => ({
  voiceSpeakTool: {
    execute: vi.fn(),
  },
}));
vi.mock("@/lib/chat/repository", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/domain/artifacts/repository", () => ({ createArtifact: vi.fn() }));

import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { voiceSpeakTool } from "@/lib/tools/media/voice-speak";
import { looksLikeDemandeSon, runSonTurn } from "./engine-media";

const mockedAppend = vi.mocked(appendMessage);
const mockedCreate = vi.mocked(createArtifact);
const mockedExecute = vi.mocked(voiceSpeakTool.execute);

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

describe("looksLikeDemandeSon — détection déterministe", () => {
  const positifs = [
    "Crée le son de la pluie qui tombe sur les vitres pendant l'orage.",
    "génère le bruit de vagues sur la plage",
    "fais-moi l'ambiance d'un feu de cheminée",
    "Crée le bruit d'un train qui passe",
    "produis le son d'une cloche d'église",
  ];
  for (const m of positifs) {
    it(`positif : « ${m.slice(0, 44)} »`, () => {
      expect(looksLikeDemandeSon(m)).toBe(true);
    });
  }
  const negatifs = [
    "Crée une vidéo avec le son de la pluie", // vidéo d'abord
    "Crée un message vocal d'une femme qui se présente", // voix parlée
    "Crée une musique de 2 minutes au piano", // lit musical dédié
    "Qu'est-ce que le son ?", // question méta
    "Le son de la pluie est apaisant.", // constat, AUCUN produit demandé
    "Résume ce texte en 3 points", // aucun objet sonore
  ];
  for (const m of negatifs) {
    it(`négatif : « ${m.slice(0, 44)} »`, () => {
      expect(looksLikeDemandeSon(m)).toBe(false);
    });
  }
});

describe("runSonTurn — livraison dans le fil", () => {
  it("succès : message avec audioUrl durable + artefact audio + JAMAIS de lecture vocale", async () => {
    mockedExecute.mockResolvedValue({
      url: "users/u1/permanent/ai-audio/son-pluie.wav",
      storage: "r2",
      cleStockage: "users/u1/permanent/ai-audio/son-pluie.wav",
      ecouterUrl: "https://www.gen3ia.online/api/media/durable?path=users%2Fu1%2Fpermanent%2Fai-audio%2Fson-pluie.wav",
      mimeType: "audio/wav",
      dureeSecondes: 10,
      moteur: "gen3-snn-audio-v2-scene",
      note: "Design sonore sémantique gen3 — couches réelles pluie/vagues/orage/feu… ; ce n'est pas une parole, le texte n'a jamais été lu à voix haute.",
    } as never);
    const resultat = await runSonTurn(baseCtx("Crée le son de la pluie qui tombe sur les vitres") as never);
    expect(mockedExecute).toHaveBeenCalledTimes(1);
    const appel = mockedExecute.mock.calls[0]?.[0] as { dureeSecondes?: number };
    expect(appel.dureeSecondes).toBe(10); // défaut ambiance (pas de durée explicite)
    const message = mockedAppend.mock.calls[0]?.[0] as { audioUrl?: string; content: string };
    expect(message.audioUrl).toBe("/api/media/durable?path=users%2Fu1%2Fpermanent%2Fai-audio%2Fson-pluie.wav");
    expect(message.content).toContain("son");
    expect(message.content).toContain("design sonore");
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "audio" }));
    expect(resultat.artifacts).toHaveLength(1);
    expect(mockedAppend.mock.calls[0]?.[0]).toHaveProperty("generationStatus", "complete");
  });

  it("durée EXPLICITE lue dans la demande (« 15 secondes »)", async () => {
    mockedExecute.mockResolvedValue({
      url: "users/u1/permanent/ai-audio/son-pluie.wav",
      storage: "r2",
      cleStockage: "users/u1/permanent/ai-audio/son-pluie.wav",
      ecouterUrl: "https://x.test/d",
      mimeType: "audio/wav",
      dureeSecondes: 15,
      moteur: "gen3-snn-audio-v2-scene",
      note: "Design sonore sémantique gen3 — couches réelles.",
    } as never);
    await runSonTurn(baseCtx("Crée le son de la pluie pendant 15 secondes") as never);
    expect(mockedExecute).toHaveBeenCalledWith(
      expect.objectContaining({ dureeSecondes: 15 }),
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("échec honnête : cause nommée, aucun faux succès, aucun lien mort", async () => {
    mockedExecute.mockRejectedValue(new Error("moteur scénique indisponible"));
    const resultat = await runSonTurn(baseCtx("Crée le son de la pluie") as never);
    const message = mockedAppend.mock.calls[0]?.[0] as { content: string; audioUrl?: string };
    expect(message.content).toContain("pas réussi");
    expect(message.content).toContain("moteur scénique indisponible");
    expect(message.audioUrl).toBeUndefined();
    expect(resultat.artifacts).toHaveLength(0);
  });

  it("défense : une note NON design-sonore (nappe) refuse la livraison du tour son", async () => {
    mockedExecute.mockResolvedValue({
      url: "users/u1/permanent/ai-audio/nappe.wav",
      storage: "r2",
      cleStockage: "users/u1/permanent/ai-audio/nappe.wav",
      ecouterUrl: "https://x.test/d",
      mimeType: "audio/wav",
      dureeSecondes: 10,
      moteur: "gen3-snn-audio-v1-nappe",
      note: "Audio synthétisé localement par le moteur neuronal Gen3 (composition harmonique dérivée du texte). Ce rendu n'est pas une parole humaine naturelle.",
    } as never);
    await runSonTurn(baseCtx("Crée le son de la pluie") as never);
    const message = mockedAppend.mock.calls[0]?.[0] as { content: string };
    // Le rendu nappe n'est pas le bon lit pour un SON nommé → échec honnête
    // (cause nommée, aucun faux succès, aucun lecteur livré à tort).
    expect(message.content).toContain("pas réussi");
    expect(message.content).toContain("ROUTAGE_SON_NON_RESOLU");
  });
});
