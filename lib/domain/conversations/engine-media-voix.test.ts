import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIX production (capture 2026-11-11 19:12) : « Crée une message vocal
 * d'une femme qui se présente devant un homme » restait SANS chemin
 * exécutable (réponse « intention TRAITEMENT_REQUETE que je ne sais pas
 * encore exécuter »). Le tour voix est désormais SERVEUR D'ABORD : la
 * cascade professeur (passerelle → espace public Edge-TTS) produit une
 * voix réelle et l'audio est livré IMMÉDIATEMENT dans le fil (message +
 * artefact). Verrous :
 *  - succès serveur → message « Voici votre message vocal » + artefact
 *    audio + événements message_complete ET artifact_created ;
 *  - la voix suit le PERSONNAGE (femme → Edge féminine) ;
 *  - un SCÉNARIO sans citation est RÉALISÉ par l'IA centrale (l'instruction
 *    n'est JAMAIS lue telle quelle) ;
 *  - échec serveur → cascade WebGPU historique (événement webgpu_media).
 */

const mocks = vi.hoisted(() => ({
  genererVoixHumaineProfesseurEtPersister: vi.fn(),
  generate: vi.fn(),
  appendMessage: vi.fn(),
  createArtifact: vi.fn(),
}));

vi.mock("@/lib/neural/media-service", () => ({
  genererVoixHumaineProfesseurEtPersister: mocks.genererVoixHumaineProfesseurEtPersister,
}));

vi.mock("@/lib/ai/router", () => ({
  generate: mocks.generate,
}));

vi.mock("@/lib/chat/repository", () => ({
  appendMessage: mocks.appendMessage,
}));

vi.mock("@/lib/domain/artifacts/repository", () => ({
  createArtifact: mocks.createArtifact,
}));

import { runVoixTurn, texteÀFaireDire } from "./engine-media";
import type { TurnBase } from "./engine-chat";

const RENDU = {
  url: "https://r2.test/voix.mp3",
  storage: "r2",
  mime: "audio/mpeg",
  meta: { moteur: "professeur-voix-espace-edge-tts", voix: "fr-FR-DeniseNeural - fr-FR (Female)", echafaudage: true },
  generationId: "voix-1",
  cleStockage: "users/u/permanent/professeur-media/voix.mp3",
};

function ctx(message: string): { ctx: TurnBase; events: unknown[] } {
  const events: unknown[] = [];
  const ctx = {
    userId: "user-1",
    conversationId: "conv-1",
    projectId: undefined,
    message,
    userMessage: { id: "um-1" },
    attachments: [],
    onEvent: async (e: unknown) => {
      events.push(e);
    },
  } as unknown as TurnBase;
  return { ctx, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appendMessage.mockResolvedValue({ id: "am-1", content: "x" });
  mocks.createArtifact.mockResolvedValue({ id: "art-1", type: "audio" });
});

describe("runVoixTurn — voix serveur d'abord (sans dépendre du GPU navigateur)", () => {
  it("LA demande de production échouée 19:12 → audio réel livré dans le fil (voix féminine)", async () => {
    mocks.genererVoixHumaineProfesseurEtPersister.mockResolvedValue(RENDU);
    mocks.generate.mockResolvedValue({ text: "Bonjour, je suis ravie de vous rencontrer. Comment allez-vous ?", model: "gen3-snn-v1" });

    const { ctx: base, events } = ctx("Crée une message vocal d'une femme qui se présente devant un homme");
    const résultat = await runVoixTurn(base);

    // Texte parlé RÉALISÉ par l'IA centrale (jamais l'instruction lue).
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    // Voix du PERSONNAGE : féminine (Denise).
    expect(mocks.genererVoixHumaineProfesseurEtPersister).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", voix: "fr-FR-DeniseNeural - fr-FR (Female)" }),
    );
    // Livraison complète : message + artefact + DEUX événements.
    expect(résultat.assistantMessage).toMatchObject({ id: "am-1" });
    expect(mocks.appendMessage.mock.calls[0]?.[0].content).toContain("Voici votre message vocal");
    expect(mocks.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ type: "audio", storagePath: RENDU.cleStockage }));
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("message_complete");
    expect(types).toContain("artifact_created");
    expect(types).not.toContain("webgpu_media");
  });

  it("citation explicite → lue LITTÉRALEMENT (aucun appel IA, zéro invention)", async () => {
    mocks.genererVoixHumaineProfesseurEtPersister.mockResolvedValue(RENDU);
    const { ctx: base } = ctx("Fais une voix qui dit : \"Bonjour à tous, bienvenue\"");
    await runVoixTurn(base);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.genererVoixHumaineProfesseurEtPersister).toHaveBeenCalledWith(
      expect.objectContaining({ texte: "Bonjour à tous, bienvenue" }),
    );
  });

  it("serveur indisponible → cascade WebGPU historique (jamais de faux succès)", async () => {
    mocks.genererVoixHumaineProfesseurEtPersister.mockResolvedValue(null);
    const { ctx: base, events } = ctx("Crée un message vocal d'accueil");
    const résultat = await runVoixTurn(base);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("webgpu_media");
    expect(types).not.toContain("artifact_created");
    expect(résultat.artifacts).toHaveLength(0);
  });
});

describe("texteÀFaireDire — scénario réalisé par l'IA centrale", () => {
  it("scénario sans citation → texte parlé écrit par le moteur neuronal", async () => {
    mocks.generate.mockResolvedValue({ text: "Bonjour, moi c'est Sarah, enchantée de faire votre connaissance." });
    const texte = await texteÀFaireDire("une femme qui se présente devant un homme");
    expect(texte).toBe("Bonjour, moi c'est Sarah, enchantée de faire votre connaissance.");
  });

  it("IA indisponible → dernier recours honnête (la demande, jamais un texte inventé)", async () => {
    mocks.generate.mockRejectedValue(new Error("moteur absent"));
    const texte = await texteÀFaireDire("un message vocal de bienvenue chaleureux");
    expect(texte).toBe("un message vocal de bienvenue chaleureux");
  });
});
