import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outils médias RÉELS (audit outils médias) — image.generate + video.create.
 *
 * Verrous :
 *  1. schémas stricts (prompts bornés, ratios/aspectRatio/URLs validés) ;
 *  2. image.generate appelle la VRAIE voie Agnes (generateImageWithAgnes) et
 *     bascule sur l'édition (editImageWithAgnes) avec images de référence ;
 *  3. les erreurs réelles remontent sans masquage ;
 *  4. video.create enfile un job RÉEL via la file de production
 *     (import paresseux) et retourne jobId/projectId/status/stage ;
 *  5. enregistrement effectif dans le registre par défaut (gated AGNES_API_KEY,
 *     aucun outil fantôme sans clé) ;
 *  6. couverture TOOL_SECURITY + catalogue GEN3IA_TOOLS + libellés FR.
 */

vi.mock("@/lib/ai/image-generation", () => ({
  generateImageWithAgnes: vi.fn(),
  editImageWithAgnes: vi.fn(),
  isImageGenerationEnabled: () => Boolean(process.env.AGNES_API_KEY),
  IMAGE_RATIOS: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
  IMAGE_SIZES: ["1K", "2K", "3K", "4K"],
  AGNES_IMAGE_MODEL: "agnes-image-2.5-flash",
}));

const createVideoProductionJobMock = vi.fn();
vi.mock("@/lib/video/production-queue", () => ({
  createVideoProductionJob: (...args: unknown[]) => createVideoProductionJobMock(...args),
}));

import { editImageWithAgnes, generateImageWithAgnes } from "@/lib/ai/image-generation";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { createDefaultToolRegistry } from "@/lib/tools/default-registry";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import { toolLabel } from "@/lib/tools/labels";
import { createVideoTool } from "./create-video";
import { generateImageTool } from "./generate-image";

const mockedGenerate = vi.mocked(generateImageWithAgnes);
const mockedEdit = vi.mocked(editImageWithAgnes);

const CONTEXT = { userId: "user-1", executionId: "exec-1" };

/**
 * Disponibilité RÉELLE de la file de production (Task 1-a en parallèle) :
 * tant que le module n'existe pas, l'import dynamique échoue (le mock est
 * ignoré — résolution impossible) et les tests d'exécution vidéo sont
 * ignorés ; dès que le module existe, le mock s'applique et ils courent.
 */
const productionQueueAvailable = await import("@/lib/video/production-queue")
  .then(() => true)
  .catch(() => false);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outil image.generate — schéma d'entrée", () => {
  it("accepte une entrée minimale valide", () => {
    const parsed = generateImageTool.inputSchema.parse({ prompt: "Un chat astronaute" });
    expect(parsed.prompt).toBe("Un chat astronaute");
  });

  it("refuse un prompt trop court (<3) et trop long (>4000)", () => {
    expect(() => generateImageTool.inputSchema.parse({ prompt: "ab" })).toThrow();
    expect(() =>
      generateImageTool.inputSchema.parse({ prompt: "a".repeat(4001) }),
    ).toThrow();
  });

  it("refuse un ratio non supporté par le modèle", () => {
    expect(() =>
      generateImageTool.inputSchema.parse({ prompt: "Un chat astronaute", ratio: "7:3" }),
    ).toThrow();
  });

  it("refuse une taille non supportée", () => {
    expect(() =>
      generateImageTool.inputSchema.parse({ prompt: "Un chat astronaute", size: "8K" }),
    ).toThrow();
  });

  it("refuse plus de 4 images de référence et une URL invalide", () => {
    expect(() =>
      generateImageTool.inputSchema.parse({
        prompt: "Un chat astronaute",
        refImageUrls: [
          "https://a.exemple.com/1.png",
          "https://a.exemple.com/2.png",
          "https://a.exemple.com/3.png",
          "https://a.exemple.com/4.png",
          "https://a.exemple.com/5.png",
        ],
      }),
    ).toThrow();
    expect(() =>
      generateImageTool.inputSchema.parse({
        prompt: "Un chat astronaute",
        refImageUrls: ["pas-une-url"],
      }),
    ).toThrow();
  });
});

describe("outil image.generate — exécution réelle (voie Agnes)", () => {
  it("appelle generateImageWithAgnes et retourne { url, provider, model, latencyMs, taskId }", async () => {
    mockedGenerate.mockResolvedValue({
      imageUrl: "https://cdn.exemple.com/img.png",
      model: "agnes-image-2.5-flash",
      taskId: "task-1",
      latencyMs: 1234,
    });
    const output = await generateImageTool.execute(
      { prompt: "Un chat astronaute", ratio: "16:9", size: "2K" },
      CONTEXT,
    );
    expect(mockedGenerate).toHaveBeenCalledWith({
      prompt: "Un chat astronaute",
      ratio: "16:9",
      size: "2K",
    });
    expect(mockedEdit).not.toHaveBeenCalled();
    expect(output).toEqual({
      url: "https://cdn.exemple.com/img.png",
      provider: "agnes",
      model: "agnes-image-2.5-flash",
      latencyMs: 1234,
      taskId: "task-1",
    });
  });

  it("bascule sur la voie édition/composition dès qu'une image de référence est fournie", async () => {
    mockedEdit.mockResolvedValue({
      imageUrl: "https://cdn.exemple.com/edited.png",
      model: "agnes-image-2.5-flash",
      latencyMs: 900,
    });
    const output = await generateImageTool.execute(
      {
        prompt: "Rends le fond bleu",
        refImageUrls: ["https://exemple.com/source.png", "data:image/png;base64,AAAA"],
      },
      CONTEXT,
    );
    expect(mockedEdit).toHaveBeenCalledWith({
      prompt: "Rends le fond bleu",
      images: ["https://exemple.com/source.png", "data:image/png;base64,AAAA"],
    });
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(output.url).toBe("https://cdn.exemple.com/edited.png");
    expect(output.provider).toBe("agnes");
    expect(output).not.toHaveProperty("taskId");
  });

  it("propage l'erreur réelle d'Agnes SANS masquage ni repli silencieux", async () => {
    mockedGenerate.mockRejectedValue(new Error("Agnes AI a renvoyé une erreur HTTP 503."));
    await expect(
      generateImageTool.execute({ prompt: "un paysage alpin" }, CONTEXT),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("outil video.create — schéma d'entrée", () => {
  it("accepte un brief valide avec options", () => {
    const parsed = createVideoTool.inputSchema.parse({
      prompt: "Une vidéo de présentation de 60 secondes sur Paris",
      title: "Paris en 60 s",
      aspectRatio: "9:16",
      voiceEnabled: true,
      subtitlesEnabled: false,
    });
    expect(parsed.aspectRatio).toBe("9:16");
  });

  it("refuse un prompt trop court (<10) et un aspectRatio invalide", () => {
    expect(() => createVideoTool.inputSchema.parse({ prompt: "tropcourt" })).toThrow();
    expect(() =>
      createVideoTool.inputSchema.parse({
        prompt: "Une vidéo de présentation complète",
        aspectRatio: "4:3",
      }),
    ).toThrow();
  });

  it("refuse un prompt trop long (>4000) et un titre trop long (>120)", () => {
    expect(() =>
      createVideoTool.inputSchema.parse({ prompt: "a".repeat(4001) }),
    ).toThrow();
    expect(() =>
      createVideoTool.inputSchema.parse({
        prompt: "Une vidéo de présentation complète",
        title: "t".repeat(121),
      }),
    ).toThrow();
  });
});

describe("outil video.create — exécution réelle (file de production)", () => {
  it.runIf(productionQueueAvailable)("enfile un job via createVideoProductionJob (import paresseux) et retourne jobId/projectId/status/stage", async () => {
    createVideoProductionJobMock.mockResolvedValue({
      jobId: "job-1",
      projectId: "proj-1",
      status: "queued",
      stage: "project",
      queueMode: "qstash",
    });
    const output = await createVideoTool.execute(
      {
        prompt: "Une vidéo de présentation de 60 secondes sur Paris",
        title: "  Paris en 60 s  ",
        aspectRatio: "9:16",
        voiceEnabled: true,
      },
      CONTEXT,
    );
    expect(createVideoProductionJobMock).toHaveBeenCalledWith({
      userId: "user-1",
      prompt: "Une vidéo de présentation de 60 secondes sur Paris",
      title: "Paris en 60 s",
      options: { aspectRatio: "9:16", voiceEnabled: true },
    });
    expect(output).toEqual({
      jobId: "job-1",
      projectId: "proj-1",
      status: "queued",
      stage: "project",
      queueMode: "qstash",
    });
    expect(createVideoProductionJobMock).toHaveBeenCalledTimes(1);
  });

  it.runIf(productionQueueAvailable)("ne transmet pas de title vide ni d'options absentes", async () => {
    createVideoProductionJobMock.mockResolvedValue({
      jobId: "job-2",
      projectId: "proj-2",
      status: "queued",
      stage: "script",
      queueMode: "poll",
    });
    const output = await createVideoTool.execute(
      { prompt: "Une vidéo d'explication du cycle de l'eau", title: "   " },
      CONTEXT,
    );
    expect(createVideoProductionJobMock).toHaveBeenCalledWith({
      userId: "user-1",
      prompt: "Une vidéo d'explication du cycle de l'eau",
      options: {},
    });
    expect(output).toEqual({
      jobId: "job-2",
      projectId: "proj-2",
      status: "queued",
      stage: "script",
      queueMode: "poll",
    });
  });

  it.runIf(productionQueueAvailable)("propage l'erreur réelle de la file sans masquage", async () => {
    createVideoProductionJobMock.mockRejectedValue(new Error("File de production saturée"));
    await expect(
      createVideoTool.execute(
        { prompt: "Une vidéo de présentation de 60 secondes sur Rome" },
        CONTEXT,
      ),
    ).rejects.toThrow(/saturée/);
  });

  it.runIf(!productionQueueAvailable)("file indisponible : l'exécution échoue avec l'erreur française claire", async () => {
    await expect(
      createVideoTool.execute(
        { prompt: "Une vidéo de présentation de 60 secondes sur Paris" },
        CONTEXT,
      ),
    ).rejects.toThrow(/production vid[ée]o n'est pas disponible/i);
    expect(createVideoProductionJobMock).not.toHaveBeenCalled();
  });
});

describe("enregistrement dans le registre par défaut (gated AGNES_API_KEY)", () => {
  it("enregistre image.generate et video.create quand Agnes est configuré", () => {
    vi.stubEnv("AGNES_API_KEY", "test-key");
    const registry = createDefaultToolRegistry();
    const image = registry.get("image.generate");
    expect(image).toBeDefined();
    expect(image?.category).toBe("media");
    expect(image?.risk).toBe("medium");
    const video = registry.get("video.create");
    expect(video).toBeDefined();
    expect(video?.category).toBe("media");
    expect(video?.risk).toBe("high");
    // La liste déduplique par id : un seul outil logique par identifiant.
    expect(registry.list().filter((tool) => tool.id === "image.generate")).toHaveLength(1);
    expect(registry.list().filter((tool) => tool.id === "video.create")).toHaveLength(1);
  });

  it("n'enregistre AUCUN outil média sans AGNES_API_KEY (aucune capacité fantôme)", () => {
    vi.stubEnv("AGNES_API_KEY", "");
    const registry = createDefaultToolRegistry();
    expect(registry.has("image.generate")).toBe(false);
    expect(registry.has("video.create")).toBe(false);
  });
});

describe("couverture sécurité + catalogue + libellés", () => {
  it("TOOL_SECURITY : image.generate = external + réseau (profil voice.speak)", () => {
    const definition = getToolSecurityDefinition("image.generate");
    expect(definition.risk).toBe("external");
    expect(definition.network).toBe(true);
    expect(definition.requiredPermissions).toContain("tool.external");
    expect(definition.requiredPermissions).toContain("network.read");
  });

  it("TOOL_SECURITY : video.create = écriture interne (file), risque HITL porté par l'outil", () => {
    const definition = getToolSecurityDefinition("video.create");
    expect(definition.risk).toBe("write");
    expect(definition.network).toBeUndefined();
    expect(definition.externalApp).toBeUndefined();
    expect(definition.requiredPermissions).toEqual(["tool.read", "tool.write"]);
  });

  it("GEN3IA_TOOLS référence les deux outils médias avec les descriptions attendues", () => {
    const image = GEN3IA_TOOLS.find((tool) => tool.name === "image.generate");
    const video = GEN3IA_TOOLS.find((tool) => tool.name === "video.create");
    expect(image?.description).toMatch(/image/i);
    expect(image?.description).toMatch(/ratio/i);
    expect(image?.sideEffect).toBe(false);
    expect(video?.description).toMatch(/production vid[ée]o/i);
    expect(video?.description).toMatch(/progression/i);
    expect(video?.sideEffect).toBe(true);
    // Sensibles au durcissement : auto_allow + médias → ask_if_needed.
    expect(["external", "destructive"]).toContain(image?.risk);
    expect(["external", "destructive"]).toContain(video?.risk);
  });

  it("libellés FR : jamais le slug brut à l'utilisateur", () => {
    expect(toolLabel("image.generate")).toBe("Génération d'image");
    expect(toolLabel("video.create")).toBe("Production vidéo");
  });
});
