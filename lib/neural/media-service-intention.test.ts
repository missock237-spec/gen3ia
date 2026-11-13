import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROUTAGE AUTOMATIQUE DE L'INTENTION AUDIO (media-service) :
 * la génération sonore doit correspondre à la nature de la demande SANS
 * que l'utilisateur ait à le demander. Verrous :
 *  1. nature « son » / « musique » (détectée OU forcée) → professeurVoix
 *     JAMAIS appelé — le texte n'est jamais lu à voix haute pour un
 *     bruit ; moteur scénique local + meta.intention (traçabilité) ;
 *  2. nature « voix » → professeur TTS réel appelé AVEC la vitesse
 *     expressive automatique (chemin ultra-réaliste automatique) ;
 *  3. nature « inconnu » → comportement historique (TTS si dispo,
 *     sans vitesse explicite) ;
 *  4. échec du TTS → repli local honnête ;
 *  5. la vitesse fait partie du contenu (clé de cache distincte).
 */

const professeurDisponibleMock = vi.fn();
const professeurVoixMock = vi.fn();
const headR2ObjectMock = vi.fn();
const persistGeneratedBufferMock = vi.fn();

vi.mock("./professeur-media", () => ({
  professeurDisponibleAsync: (...args: unknown[]) => professeurDisponibleMock(...args),
  professeurVoix: (...args: unknown[]) => professeurVoixMock(...args),
  professeurVoixEspace: vi.fn(),
  professeurImage: vi.fn(),
  professeurVideo: vi.fn(),
}));

vi.mock("./runtime", () => ({
  getNeuralRuntime: () => ({
    reseau: {
      config: { seed: 42 },
      synapses: [{ sourceId: 1, targetId: 2, weight: 0.7 }],
      neurones: new Map([[1, { energy: 0.5 }]]),
      getStats: () => ({
        nbNeurones: 2,
        nbSynapses: 1,
        poidsMoyen: 0.7,
        histogramme: Array.from({ length: 10 }, () => 0.1),
      }),
    },
  }),
}));

vi.mock("@/lib/storage/r2", () => ({
  headR2Object: (...args: unknown[]) => headR2ObjectMock(...args),
  isR2Configured: () => true,
  createR2DownloadUrl: async (key: string) => `https://r2.signe.exemple/${key}`,
}));

vi.mock("@/lib/media/persist", () => ({
  persistGeneratedBuffer: (...args: unknown[]) => persistGeneratedBufferMock(...args),
}));

import { genererAudioNeuralEtPersister } from "./media-service";

describe("media-service — routage automatique de l'intention audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    professeurDisponibleMock.mockReturnValue(true);
    professeurVoixMock.mockResolvedValue({
      buffer: Buffer.alloc(2048, 7),
      mime: "audio/wav",
      meta: { moteur: "professeur-voix-temporaire", echafaudage: true },
    });
    headR2ObjectMock.mockResolvedValue(null);
    persistGeneratedBufferMock.mockImplementation(async (params: { fixedKey?: string }) => ({
      url: `https://r2.signe.exemple/${params.fixedKey ?? "sans-cle"}`,
      storage: "r2",
      storagePath: params.fixedKey,
    }));
  });

  it("« le son de la pluie » → design sonore local, professeurVoix JAMAIS appelé", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "le son de la pluie sur les vitres",
      dureeSecondes: 2,
    });
    expect(professeurVoixMock).not.toHaveBeenCalled();
    expect(resultat.meta.moteur).toBe("gen3-snn-audio-v2-scene");
    expect(resultat.meta.intention).toMatchObject({ nature: "son" });
    expect(String((resultat.meta.intention as { motif: string }).motif).length).toBeGreaterThan(0);
    expect(persistGeneratedBufferMock).toHaveBeenCalledTimes(1);
  });

  it("musique → jamais le TTS (moteur local + traçabilité intention)", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "une berceuse pour piano",
      dureeSecondes: 2,
    });
    expect(professeurVoixMock).not.toHaveBeenCalled();
    expect(resultat.meta.intention).toMatchObject({ nature: "musique" });
    expect(String(resultat.meta.moteur)).toMatch(/^gen3-snn-audio-v/);
  });

  it("override explicite nature=\"son\" sur un prompt de parole → TTS court-circuité", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "lis ce texte",
      nature: "son",
      dureeSecondes: 2,
    });
    expect(professeurVoixMock).not.toHaveBeenCalled();
    expect(resultat.meta.intention).toMatchObject({ nature: "son" });
  });

  it("nature « voix » → professeurVoix appelé AVEC la vitesse expressive", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "lis ce texte à voix haute",
    });
    expect(professeurVoixMock).toHaveBeenCalledTimes(1);
    expect(professeurVoixMock).toHaveBeenCalledWith({
      texte: "lis ce texte à voix haute",
      vitesse: 1,
    });
    expect(resultat.meta.cache).toBe("professeur");
    expect(resultat.meta.intention).toMatchObject({ nature: "voix", vitesse: 1 });
  });

  it("parole lente détectée → vitesse 0.85 transmise au TTS", async () => {
    await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "lis ce texte de méditation doucement",
    });
    expect(professeurVoixMock).toHaveBeenCalledWith(
      expect.objectContaining({ vitesse: 0.85 }),
    );
  });

  it("la vitesse fait partie du contenu : deux vitesses → deux clés de cache", async () => {
    await genererAudioNeuralEtPersister({ userId: "u1", prompt: "lis ce texte", vitesse: 0.85 });
    await genererAudioNeuralEtPersister({ userId: "u1", prompt: "lis ce texte", vitesse: 1 });
    const [cle1, cle2] = persistGeneratedBufferMock.mock.calls.map(
      (call) => (call[0] as { fixedKey?: string }).fixedKey,
    );
    expect(cle1).toBeTruthy();
    expect(cle2).not.toBe(cle1);
  });

  it("nature « inconnu » → comportement historique (TTS sans vitesse explicite)", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "xyzzy florb quux",
    });
    expect(professeurVoixMock).toHaveBeenCalledTimes(1);
    const appel = professeurVoixMock.mock.calls[0]?.[0] as { texte: string; vitesse?: number };
    expect(appel.texte).toBe("xyzzy florb quux");
    expect(appel.vitesse).toBeUndefined();
    expect(resultat.meta.cache).toBe("professeur");
    expect(resultat.meta.intention).toMatchObject({ nature: "inconnu" });
  });

  it("échec du TTS sur une parole → repli local honnête (nappe)", async () => {
    professeurVoixMock.mockRejectedValue(new Error("Professeur voix 503"));
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "lis ce texte",
      dureeSecondes: 2,
    });
    expect(professeurVoixMock).toHaveBeenCalledTimes(1);
    expect(resultat.meta.moteur).toBe("gen3-snn-audio-v1-nappe");
    expect(resultat.meta.intention).toMatchObject({ nature: "voix" });
  });
});
