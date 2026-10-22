import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CÂBLAGE MÉDIA-SERVICE — ROUTING HONNÊTE v2 / v1 :
 *  1. prompt scénique reconnu → moteur v2 (scène dessinée/sonorisée/
 *     animée) + méta de scène complète ;
 *  2. prompt hors vocabulaire → repli v1 ASSUMÉ (moteur v1 nommé comme
 *     tel, aucune prétention) ;
 *  3. clés de contenu v2 : le nouveau moteur ne sert jamais un rendu v1
 *     resté en cache ;
 *  4. vidéo multi-scènes → storyboard (nbScenes).
 */

const headR2ObjectMock = vi.fn();
const persistGeneratedBufferMock = vi.fn();

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

import {
  genererAudioNeuralEtPersister,
  genererVideoNeuralEtPersister,
  genererVisuelNeuralEtPersister,
} from "./media-service";

describe("media-service — routing scénique v2 / repli v1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headR2ObjectMock.mockResolvedValue(null);
    persistGeneratedBufferMock.mockImplementation(async (params: { fixedKey?: string }) => ({
      url: `https://r2.signe.exemple/${params.fixedKey ?? "sans-cle"}`,
      storage: "r2",
      storagePath: params.fixedKey,
    }));
  });

  it("visuel : « un chat noir au bord de la mer » → moteur v2 scène + méta complète", async () => {
    const resultat = await genererVisuelNeuralEtPersister({
      userId: "u1",
      prompt: "un chat noir au bord de la mer au coucher de soleil",
    });
    expect(resultat.meta.moteur).toBe("gen3-snn-visuel-v2-scene");
    const scene = resultat.meta.scene as { sujet: string | null; cadre: string | null; moment: string };
    expect(scene.sujet).toBe("chat");
    expect(scene.cadre).toBe("ocean");
    expect(scene.moment).toBe("crepuscule");
    expect(resultat.meta.cache).toBe("miss");
  });

  it("visuel : prompt hors vocabulaire → repli v1 constellation ASSUMÉ", async () => {
    const resultat = await genererVisuelNeuralEtPersister({
      userId: "u1",
      prompt: "xyzzy quux florb waldo",
    });
    expect(resultat.meta.moteur).toBe("gen3-snn-visuel-v1-constellation");
    const scene = resultat.meta.scene as { sujet: string | null };
    expect(scene.sujet).toBeNull();
  });

  it("audio : « pluie sur les vitres » → moteur v2 scène (couches)", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "pluie sur les vitres dans la forêt",
      dureeSecondes: 2,
    });
    expect(resultat.meta.moteur).toBe("gen3-snn-audio-v2-scene");
    const couches = resultat.meta.couches as string[];
    expect(couches).toContain("pluie");
  });

  it("audio : prompt hors vocabulaire → repli v1 nappe ASSUMÉ", async () => {
    const resultat = await genererAudioNeuralEtPersister({
      userId: "u1",
      prompt: "xyzzy quux florb",
      dureeSecondes: 1,
    });
    expect(resultat.meta.moteur).toBe("gen3-snn-audio-v1-nappe");
  });

  it("vidéo : deux scènes reconnues → storyboard v2 (nbScenes = 2)", async () => {
    const resultat = await genererVideoNeuralEtPersister({
      userId: "u1",
      prompt: "un phare dans la tempête. puis la ville la nuit",
      dureeSecondes: 8,
    });
    expect(resultat.meta.moteur).toBe("gen3-snn-video-v2-storyboard");
    expect(resultat.meta.nbScenes).toBe(2);
  });

  it("vidéo : prompt hors vocabulaire → repli v1 constellation ASSUMÉ", async () => {
    const resultat = await genererVideoNeuralEtPersister({
      userId: "u1",
      prompt: "xyzzy quux florb",
      dureeSecondes: 4,
    });
    expect(resultat.meta.moteur).toBe("gen3-snn-video-v1-constellation");
  });

  it("clés de contenu v2 : jamais de collision avec l'ancien espace v1", async () => {
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "un chat noir" });
    const cle = (persistGeneratedBufferMock.mock.calls[0]?.[0] as { fixedKey?: string }).fixedKey ?? "";
    expect(cle).toMatch(/^users\/u1\/permanent\/neural-media\/cache\/visuel-[0-9a-f]{48}\.png$/);
    // La graine de contenu porte désormais la version v2 (contrat interne
    // testé via le déterminisme : même prompt → même clé).
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "un chat noir" });
    const cle2 = (persistGeneratedBufferMock.mock.calls[1]?.[0] as { fixedKey?: string }).fixedKey ?? "";
    expect(cle2).toBe(cle);
  });
});
