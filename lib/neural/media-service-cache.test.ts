import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CACHE DÉTERMINISTE DES MÉDIAS NEURONAUX (audit multimodal, axe A) :
 * le couple (prompt, état neuronal, paramètres) est DÉTERMINISTE — la même
 * demande sur le même état de cerveau produit bit-à-bit le même rendu.
 * Verrous :
 *  1. CLÉ DE CONTENU stable : même prompt/état → même clé R2 ;
 *  2. CLÉ DE CONTENU distincte : prompt différent → clé différente ;
 *  3. CACHE HIT : la clé existante court-circuite rendu ET upload
 *     (aucun re-render sharp, aucun re-upload, meta.cache = "hit") ;
 *  4. CACHE MISS : rendu + upload DIRECT du buffer sous la clé de contenu
 *     (plus jamais le détour data URI Base64 → décodage) ;
 *  5. la clé permanente revient au client (cleStockage) — contrat artefact.
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

import { genererVisuelNeuralEtPersister } from "./media-service";

describe("media-service — cache de contenu déterministe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headR2ObjectMock.mockResolvedValue(null);
    persistGeneratedBufferMock.mockImplementation(async (params: { fixedKey?: string }) => ({
      url: `https://r2.signe.exemple/${params.fixedKey ?? "sans-cle"}`,
      storage: "r2",
      storagePath: params.fixedKey,
    }));
  });

  it("cache miss : rendu + upload direct du buffer sous une clé de contenu déterministe", async () => {
    const resultat = await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "un logo de boulangerie" });

    expect(persistGeneratedBufferMock).toHaveBeenCalledTimes(1);
    const params = persistGeneratedBufferMock.mock.calls[0]?.[0] as { fixedKey?: string; contentType: string; fallbackUrl?: string };
    expect(params.fixedKey).toMatch(/^users\/u1\/permanent\/neural-media\/cache\/visuel-[0-9a-f]{48}\.png$/);
    expect(params.contentType).toBe("image/png");
    expect(resultat.cleStockage).toBe(params.fixedKey);
    expect(resultat.meta.cache).toBe("miss");
  });

  it("déterminisme : même prompt + même état → STRICTEMENT la même clé", async () => {
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "affiche néon" });
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "affiche néon" });

    const [premiere, seconde] = persistGeneratedBufferMock.mock.calls.map(
      (call) => (call[0] as { fixedKey?: string }).fixedKey,
    );
    expect(seconde).toBe(premiere);
  });

  it("prompt différent → clé différente (jamais de faux cache hit)", async () => {
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "un chat noir" });
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "un chat blanc" });

    const [premiere, seconde] = persistGeneratedBufferMock.mock.calls.map(
      (call) => (call[0] as { fixedKey?: string }).fixedKey,
    );
    expect(seconde).not.toBe(premiere);
  });

  it("cache hit : la clé existante court-circuite rendu ET upload", async () => {
    await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "bannière aurora" });
    const cle = (persistGeneratedBufferMock.mock.calls[0]?.[0] as { fixedKey?: string }).fixedKey;

    vi.clearAllMocks();
    headR2ObjectMock.mockResolvedValue({ sizeBytes: 12_345, contentType: "image/png" });

    const hit = await genererVisuelNeuralEtPersister({ userId: "u1", prompt: "bannière aurora" });

    expect(headR2ObjectMock).toHaveBeenCalledWith(cle);
    expect(persistGeneratedBufferMock).not.toHaveBeenCalled();
    expect(hit.url).toBe(`https://r2.signe.exemple/${cle}`);
    expect(hit.storage).toBe("r2");
    expect(hit.meta.cache).toBe("hit");
  });
});
