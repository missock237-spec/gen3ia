import { readFileSync } from "node:fs";
import path from "node:path";

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
 *  6. couverture TOOL_SECURITY + catalogue GEN3IA_TOOLS + libellés FR ;
 *  7. image.generate PERSISTE l'image en R2 permanent (Task 103-a) via
 *     lib/media/persist.ts — sortie étendue { url, providerUrl, provider,
 *     model, latencyMs, taskId?, storage, storagePath? } rétrocompatible ;
 *  8. gardes structurels : la console /api/tools/execute autorise les 4
 *     outils médias et le module de persistance cible le chemin permanent
 *     users/<uid>/permanent/ai-images/ sans jamais lever d'exception.
 *
 * Choix de testabilité (Task 103-a) : le module de persistance est mocké à
 * CE niveau (frontière unitaire — la voie Agnes reste le sujet testé) dans
 * les DEUX états { storage: "r2" } et { storage: "provider" } ; le
 * comportement réel du persist (fetch/R2, replis) est couvert séparément et
 * behavioralement dans lib/media/persist.test.ts (fetch global stubé).
 */

vi.mock("@/lib/ai/image-generation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/image-generation")>();
  return {
    ...original,
    generateImageWithAgnes: vi.fn(),
    editImageWithAgnes: vi.fn(),
    isImageGenerationEnabled: () => Boolean(process.env.AGNES_API_KEY),
    IMAGE_RATIOS: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
    IMAGE_SIZES: ["1K", "2K", "3K", "4K"],
    AGNES_IMAGE_MODEL: "agnes-image-2.5-flash",
  };
});

const persistGeneratedImageMock = vi.fn();
vi.mock("@/lib/media/persist", () => ({
  persistGeneratedImage: (...args: unknown[]) => persistGeneratedImageMock(...args),
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
import { createVideoTool, VIDEO_ASPECT_RATIOS } from "./create-video";
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

describe("outil image.generate — exécution réelle (voie Agnes + persistance)", () => {
  it("appelle generateImageWithAgnes, PERSISTE en R2 et retourne l'URL permanente en priorité", async () => {
    mockedGenerate.mockResolvedValue({
      imageUrl: "https://cdn.exemple.com/img.png",
      model: "agnes-image-2.5-flash",
      taskId: "task-1",
      latencyMs: 1234,
    });
    // Persistance RÉUSSIE : l'URL retournée est celle de la copie permanente.
    persistGeneratedImageMock.mockResolvedValue({
      url: "https://r2.exemple.com/signed/permanent.png",
      storage: "r2",
      storagePath: "users/user-1/permanent/ai-images/1710000000000-abc.png",
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
    // La copie part du userId du contexte et de l'URL Agnes d'origine.
    expect(persistGeneratedImageMock).toHaveBeenCalledWith({
      userId: "user-1",
      imageUrl: "https://cdn.exemple.com/img.png",
    });
    // Contrat étendu (rétrocompatible) : url = permanente, providerUrl =
    // l'URL Agnes temporaire d'origine, storage/storagePath explicites.
    expect(output).toEqual({
      url: "https://r2.exemple.com/signed/permanent.png",
      providerUrl: "https://cdn.exemple.com/img.png",
      provider: "agnes",
      model: "agnes-image-2.5-flash",
      latencyMs: 1234,
      taskId: "task-1",
      storage: "r2",
      storagePath: "users/user-1/permanent/ai-images/1710000000000-abc.png",
    });
  });

  it("repli gracieux : échec de persistance → url = providerUrl (storage 'provider'), sans lever", async () => {
    mockedGenerate.mockResolvedValue({
      imageUrl: "https://cdn.exemple.com/img.png",
      model: "agnes-image-2.5-flash",
      latencyMs: 1100,
    });
    // persistGeneratedImage ne lève JAMAIS : en échec il retourne l'URL
    // d'origine avec storage:"provider" — l'outil reste en succès.
    persistGeneratedImageMock.mockResolvedValue({
      url: "https://cdn.exemple.com/img.png",
      storage: "provider",
    });
    const output = await generateImageTool.execute(
      { prompt: "Un chat astronaute" },
      CONTEXT,
    );
    expect(output).toEqual({
      url: "https://cdn.exemple.com/img.png",
      providerUrl: "https://cdn.exemple.com/img.png",
      provider: "agnes",
      model: "agnes-image-2.5-flash",
      latencyMs: 1100,
      storage: "provider",
    });
    expect(output).not.toHaveProperty("storagePath");
  });

  it("bascule sur la voie édition/composition dès qu'une image de référence est fournie", async () => {
    mockedEdit.mockResolvedValue({
      imageUrl: "https://cdn.exemple.com/edited.png",
      model: "agnes-image-2.5-flash",
      latencyMs: 900,
    });
    persistGeneratedImageMock.mockResolvedValue({
      url: "https://r2.exemple.com/signed/edited.png",
      storage: "r2",
      storagePath: "users/user-1/permanent/ai-images/1710000000001-def.png",
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
    expect(output.url).toBe("https://r2.exemple.com/signed/edited.png");
    expect(output.providerUrl).toBe("https://cdn.exemple.com/edited.png");
    expect(output.provider).toBe("agnes");
    expect(output.storage).toBe("r2");
    expect(output).not.toHaveProperty("taskId");
  });

  it("propage l'erreur réelle d'Agnes SANS masquage ni repli silencieux (persistance non atteinte)", async () => {
    mockedGenerate.mockRejectedValue(new Error("Agnes AI a renvoyé une erreur HTTP 503."));
    await expect(
      generateImageTool.execute({ prompt: "un paysage alpin" }, CONTEXT),
    ).rejects.toThrow(/HTTP 503/);
    expect(persistGeneratedImageMock).not.toHaveBeenCalled();
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

  it("accepte exactement les cinq ratios du constant partagé VIDEO_ASPECT_RATIOS (Task 106-a : alignement pipeline)", () => {
    expect(VIDEO_ASPECT_RATIOS).toEqual(["16:9", "9:16", "1:1", "4:5", "21:9"]);
    for (const aspectRatio of VIDEO_ASPECT_RATIOS) {
      expect(() =>
        createVideoTool.inputSchema.parse({
          prompt: "Une vidéo de présentation complète",
          aspectRatio,
        }).aspectRatio,
      ).not.toThrow();
    }
    // Toute autre valeur reste refusée (dérive de contrat impossible).
    expect(() =>
      createVideoTool.inputSchema.parse({
        prompt: "Une vidéo de présentation complète",
        aspectRatio: "4:3",
      }),
    ).toThrow();
  });
});

describe("video.create — source unique des ratios (audit médias 103-c)", () => {
  // ─── Gardes structurels (convention du dépôt) : le constant partagé est ───
  // ─── la source unique des 3 valeurs d'aspectRatio ; depuis l'audit        ───
  // ─── 103-f, l'intercept du chat (engine.ts) IMPORTE ce constant — plus   ───
  // ─── aucun littéral dupliqué entre le tool et le chat.                    ───
  const source = readFileSync(path.join(import.meta.dirname, "create-video.ts"), "utf8");

  it("garde : create-video.ts exporte VIDEO_ASPECT_RATIOS et le zod le consomme", () => {
    expect(source).toContain("export const VIDEO_ASPECT_RATIOS");
    expect(source).toContain("z.enum(VIDEO_ASPECT_RATIOS)");
    // Plus AUCUN littéral de ratio en double maintenance dans le zod.
    expect(source).not.toContain('z.enum(["16:9"');
  });

  it("garde : le constant est documenté comme source unique, intercept chat aligné", () => {
    expect(source).toContain("SOURCE UNIQUE");
    expect(source).toContain("lib/domain/conversations/engine.ts");
    expect(source).toContain("Alignement");
  });

  it("garde : l'intercept video.create du chat importe le constant partagé (audit 103-f)", () => {
    const engineSource = readFileSync(
      path.join(import.meta.dirname, "../../domain/conversations/engine.ts"),
      "utf8",
    );
    expect(engineSource).toContain('from "@/lib/tools/media/create-video"');
    expect(engineSource).toContain("VIDEO_ASPECT_RATIOS.find");
    // Plus AUCUN littéral de ratio en double maintenance dans l'intercept.
    expect(engineSource).not.toContain('aspectInput === "16:9"');
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
      studioUrl: "/studio/video/proj-1",
      appliedOptions: { aspectRatio: "9:16", voiceEnabled: true },
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
      studioUrl: "/studio/video/proj-2",
      appliedOptions: {},
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
    // Outil INTERNE (directive 10-10) : plus de risque « high » (carte HITL)
    // — exécution directe, facturée par l'escrow de mission.
    expect(video?.risk).toBe("medium");
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
  it("TOOL_SECURITY : image.generate = écriture INTERNE + réseau (outil plateforme, directive 10-10)", () => {
    const definition = getToolSecurityDefinition("image.generate");
    // Reclassification 10-10 : outil INTERNE (infrastructure Gen3ia) — plus de
    // profil « external » (aucune app utilisateur ciblée, aucun secret).
    expect(definition.risk).toBe("write");
    expect(definition.network).toBe(true);
    expect(definition.requiredPermissions).toContain("tool.write");
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
    // Outils INTERNES (directive 10-10) : risque « write » — la génération
    // ne déclenche plus le durcissement ni aucune carte de validation.
    expect(image?.risk).toBe("write");
    expect(video?.risk).toBe("write");
  });

  it("libellés FR : jamais le slug brut à l'utilisateur", () => {
    expect(toolLabel("image.generate")).toBe("Génération d'image");
    expect(toolLabel("video.create")).toBe("Production vidéo");
  });
});

/* ------------------------------------------------------------------ */
/* Gardes structurels — console d'exécution + persistance images       */
/* (Task 103-a, convention du dépôt : lecture du source)               */
/* ------------------------------------------------------------------ */

describe("gardes structurels — console /api/tools/execute + persistance des images générées (Task 103-a)", () => {
  const read = (relativePath: string) =>
    readFileSync(path.join(import.meta.dirname, relativePath), "utf8");

  it("garde : la route execute étend sa politique aux 4 outils médias (dérivée du standard)", () => {
    const source = read("../../../app/api/tools/execute/route.ts");
    // Les 4 outils médias RÉELS doivent figurer dans la liste de la console.
    expect(source).toContain('"voice.speak"');
    expect(source).toContain('"voice.list"');
    expect(source).toContain('"image.generate"');
    expect(source).toContain('"video.create"');
    // La politique reste DÉRIVÉE du standard — createAgentPolicy inchangé
    // (il sert aussi aux agents autonomes, hors périmètre de cette route).
    expect(source).toContain("createAgentPolicy(");
    expect(source).toContain('"standard"');
  });

  it("garde : generate-image.ts appelle la persistance et expose la forme de sortie étendue", () => {
    const source = read("generate-image.ts");
    expect(source).toContain("persistGeneratedImage(");
    // Contrat étendu rétrocompatible : URL provider d'origine conservée +
    // état de persistance explicite.
    expect(source).toContain("providerUrl");
    expect(source).toContain('"r2" | "provider"');
    expect(source).toContain("storagePath");
  });

  it("garde : lib/media/persist.ts cible le chemin permanent ai-images et ne lève JAMAIS", () => {
    const source = read("../../media/persist.ts");
    // Chemin permanent standard (parité chat : users/<uid>/permanent/ai-images/).
    expect(source).toContain("permanent/ai-images");
    // Pattern try/catch : dégradation gracieuse, aucune exception levée
    // (aucune INSTRUCTION throw — un « throw » dans un commentaire ne compte
    // pas, d'où l'ancre en début de ligne).
    expect(source).toContain("catch");
    expect(source).not.toMatch(/(^|\n)\s*throw\b/);
  });
});
