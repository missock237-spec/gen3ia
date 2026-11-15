import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « content.package » — Automated Content Pipeline Orchestrator (Task 140).
 *
 * Verrous :
 *  1. schéma d'entrée strict (brief borné 10→4 000, plateforme/langue
 *     énumérées, ton et audience bornés) ;
 *  2. PIPELINE de 3 appels LLM séquentiels via generateStructuredForUser —
 *     facturés au NOM de l'utilisateur (userId transmis) : angles
 *     (automation, 1500 tokens) → script (document, 3500 tokens) → SEO
 *     (automation, 1200 tokens), jamais d'appel direct à un fournisseur ;
 *  3. SÉLECTION DÉTERMINISTE du meilleur angle : engagement maximal, premier
 *     en cas d'égalité — l'angle retenu est injecté dans le prompt du script ;
 *  4. fourchette de scènes imposée par plateforme dans le prompt du script ;
 *  5. markdown français complet (Brief, Angles proposés, Script retenu,
 *     Scènes, Pack SEO, miniature) et livrable PERSISTÉ via la voie réelle
 *     (generateArtifact → storeArtifactBuffer) avec le userId du contexte ;
 *  6. les scènes sont triées par numéro dans le pack retourné.
 *
 * Frontières mockées (convention du dépôt) : voie de facturation LLM et
 * moteurs de documents — le sujet testé est le pipeline de l'outil.
 */

const generateForUserMock = vi.fn();
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
}));

const generateArtifactMock = vi.fn();
vi.mock("@/lib/documents/engine", () => ({
  generateArtifact: (...args: unknown[]) => generateArtifactMock(...args),
}));

const storeArtifactBufferMock = vi.fn();
vi.mock("@/lib/documents/artifact-store", () => ({
  storeArtifactBuffer: (...args: unknown[]) => storeArtifactBufferMock(...args),
}));

import {
  contentPackageTool,
  renderContentPackageMarkdown,
  selectBestAngle,
  type ContentAngle,
  type ContentScript,
} from "./content-package";

const CONTEXT = { userId: "user-1", executionId: "exec-pack-1" };

const ANGLES: ContentAngle[] = [
  { title: "Angle survol", hook: "Trois chiffres qui vont vous surprendre", angle: "Vue d'ensemble chiffée du sujet.", estimatedEngagement: 5 },
  { title: "Angle profond", hook: "Ce que personne ne vous explique sur ce sujet", angle: "Plongée pédagogique dans les mécanismes cachés.", estimatedEngagement: 9 },
  { title: "Angle contrarien", hook: "Et si tout ce qu'on vous a dit était faux ?", angle: "Déconstruction des idées reçues.", estimatedEngagement: 7 },
];

const SCRIPT: ContentScript = {
  hookLine: "Et si vous perdiez de l'argent à chaque fois que vous croyez en gagner ?",
  scenes: [
    {
      sceneNumber: 2,
      visualDirection: "Plan serré sur un écran de terminal, lumière bleutée nocturne, curseur clignotant",
      voiceover: "Deuxième scène volontairement désordonnée pour vérifier le tri des scènes.",
      durationSeconds: 30,
    },
    {
      sceneNumber: 1,
      visualDirection: "Gros plan sur un visage surpris, contre-plongée, lumière naturelle douce",
      voiceover: "Première scène : la promesse en trois secondes.",
      onScreenText: "LA VÉRITÉ",
      durationSeconds: 15,
    },
    {
      sceneNumber: 3,
      visualDirection: "Tableau blanc animé, tracé main, style croquis",
      voiceover: "On pose le mécanisme en trois étapes simples.",
      durationSeconds: 25,
    },
    {
      sceneNumber: 4,
      visualDirection: "Split screen : à gauche le mythe, à droite la réalité, teintes contrastées",
      voiceover: "Le mythe face à la réalité, preuves à l'appui.",
      durationSeconds: 20,
    },
    {
      sceneNumber: 5,
      visualDirection: "Plan final chaleureux, narrateur face caméra, lumière dorée",
      voiceover: "Ce qu'il faut retenir, et ce que vous pouvez faire dès aujourd'hui.",
      onScreenText: "À VOUS DE JOUER",
      durationSeconds: 10,
    },
  ],
  callToAction: "Abonnez-vous pour la suite de l'enquête.",
  totalDurationSeconds: 100,
};

const SEO = {
  titles: ["Le guide ultime", "Ce qu'on ne vous dit pas", "3 vérités dérangeantes"],
  description: "Description complète du contenu avec structure claire et promesse vérifiable.",
  keywords: ["productivité", "intelligence artificielle", "méthode"],
  hashtags: ["#ia", "#productivite", "#contenu"],
  thumbnailConcept: "Visage expressif sur fond contrasté, texte choc de trois mots.",
};

function llmJson(payload: unknown) {
  return { response: { text: JSON.stringify(payload) } };
}

function mockHappyPipeline() {
  generateForUserMock
    .mockResolvedValueOnce(llmJson({ angles: ANGLES }))
    .mockResolvedValueOnce(llmJson(SCRIPT))
    .mockResolvedValueOnce(llmJson(SEO));
}

function mockArtifactPipeline() {
  generateArtifactMock.mockResolvedValue({
    filename: "pack-de-contenu.md",
    format: "md",
    mimeType: "text/markdown",
    data: Buffer.from("# Pack de contenu — YouTube"),
  });
  storeArtifactBufferMock.mockResolvedValue({
    artifactId: "stored-pack-1",
    name: "pack-de-contenu.md",
    storageKey: "users/user-1/artifacts/stored-pack-1/pack-de-contenu.md",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outil content.package — schéma d'entrée", () => {
  it("accepte une entrée minimale valide avec les défauts youtube/français", () => {
    const parsed = contentPackageTool.inputSchema.parse({ brief: "Démystifier l'IA pour les artisans" });
    expect(parsed.platform).toBe("youtube");
    expect(parsed.language).toBe("fr");
    expect(parsed.tone).toBeUndefined();
    expect(parsed.audience).toBeUndefined();
  });

  it("(d) refuse un brief trop court (< 10) ou trop long (> 4 000)", () => {
    expect(() => contentPackageTool.inputSchema.parse({ brief: "tropcourt" })).toThrow();
    expect(() => contentPackageTool.inputSchema.parse({ brief: "x".repeat(4_001) })).toThrow();
  });

  it("refuse une plateforme ou une langue hors énumération, un ton trop long", () => {
    expect(() => contentPackageTool.inputSchema.parse({ brief: "Un brief valide", platform: "snapchat" })).toThrow();
    expect(() => contentPackageTool.inputSchema.parse({ brief: "Un brief valide", language: "es" })).toThrow();
    expect(() => contentPackageTool.inputSchema.parse({ brief: "Un brief valide", tone: "t".repeat(121) })).toThrow();
  });
});

describe("sélection du meilleur angle — déterminisme", () => {
  it("retient l'engagement maximal et départage au premier en cas d'égalité", () => {
    expect(selectBestAngle(ANGLES).title).toBe("Angle profond");
    const tied = [
      { title: "Premier", hook: "h", angle: "a", estimatedEngagement: 8 },
      { title: "Deuxième", hook: "h", angle: "a", estimatedEngagement: 8 },
    ];
    expect(selectBestAngle(tied).title).toBe("Premier");
  });
});

describe("outil content.package — pipeline (3 appels LLM + persistance réelle)", () => {
  it("(a/c) pipeline complet : 3 appels LLM séquentiels, meilleur angle injecté dans le script, livrable PERSISTÉ", async () => {
    mockHappyPipeline();
    mockArtifactPipeline();

    const output = await contentPackageTool.execute(
      {
        brief: "Une vidéo qui démystifie l'intelligence artificielle pour les artisans du bâtiment.",
        tone: "pédagogique et complice",
        audience: "artisans du bâtiment",
      },
      CONTEXT,
    );

    // — (c) Exactement 3 appels LLM facturés au nom de l'utilisateur —
    expect(generateForUserMock).toHaveBeenCalledTimes(3);
    for (const call of generateForUserMock.mock.calls) {
      expect(call[0].userId).toBe("user-1");
      expect(call[0].executionId).toBe("exec-pack-1");
    }
    // Séquence des tâches et budgets de tokens contractuels.
    const tasks = generateForUserMock.mock.calls.map((call) => call[0].request.task);
    expect(tasks).toEqual(["automation", "document", "automation"]);
    expect(generateForUserMock.mock.calls[0][0].request.maxTokens).toBe(1500);
    expect(generateForUserMock.mock.calls[1][0].request.maxTokens).toBe(3500);
    expect(generateForUserMock.mock.calls[2][0].request.maxTokens).toBe(1200);

    // — (a) Meilleur angle (engagement 9) injecté dans le prompt du script —
    const anglesPrompt = generateForUserMock.mock.calls[0][0].request.messages[0].content;
    expect(anglesPrompt).toContain("pédagogique et complice");
    expect(anglesPrompt).toContain("artisans du bâtiment");
    expect(anglesPrompt).toContain("YouTube");
    const scriptPrompt = generateForUserMock.mock.calls[1][0].request.messages[0].content;
    expect(scriptPrompt).toContain("Angle profond");
    expect(scriptPrompt).toContain("9/10");
    expect(scriptPrompt).toContain("Ce que personne ne vous explique sur ce sujet");
    // Fourchette de scènes YouTube imposée dans le prompt.
    expect(generateForUserMock.mock.calls[1][0].request.system).toContain("5 à 12 scènes");

    // — Scènes triées par numéro dans le pack retourné —
    expect(output.pack.angles).toHaveLength(3);
    expect(output.pack.script.scenes.map((scene) => scene.sceneNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(output.pack.seo.titles).toHaveLength(3);

    // — Persistance réelle avec le userId du contexte —
    expect(generateArtifactMock).toHaveBeenCalledTimes(1);
    expect(generateArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        executionId: "exec-pack-1",
        plan: expect.objectContaining({ title: "Pack de contenu — YouTube", format: "md" }),
      }),
    );
    expect(storeArtifactBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "user-1", name: "pack-de-contenu.md" }),
    );
    expect(output.artifactId).toBe("stored-pack-1");
    expect(output.filename).toBe("pack-de-contenu.md");
  });

  it("impose la fourchette de scènes courte sur TikTok (6 à 10)", async () => {
    mockHappyPipeline();
    mockArtifactPipeline();

    await contentPackageTool.execute(
      { brief: "Un format court et percutant sur le budget des independents.", platform: "tiktok" },
      CONTEXT,
    );

    expect(generateForUserMock.mock.calls[1][0].request.system).toContain("6 à 10 scènes");
    expect(generateForUserMock.mock.calls[1][0].request.system).toContain("TikTok");
  });

  it("bascule la consigne de langue en anglais quand language = en", async () => {
    mockHappyPipeline();
    mockArtifactPipeline();

    await contentPackageTool.execute(
      { brief: "A punchy short-form video about solopreneur budgeting.", language: "en" },
      CONTEXT,
    );

    expect(generateForUserMock.mock.calls[0][0].request.system).toContain("Write all content in ENGLISH.");
  });

  it("(b) rendu markdown : toutes les sections françaises présentes, scènes et SEO complets", () => {
    const markdown = renderContentPackageMarkdown({
      platform: "youtube",
      brief: "Démystifier l'IA pour les artisans.",
      angles: ANGLES,
      selectedAngle: selectBestAngle(ANGLES),
      script: SCRIPT,
      seo: SEO,
    });

    expect(markdown).toContain("# Pack de contenu — YouTube");
    expect(markdown).toContain("## Brief");
    expect(markdown).toContain("Démystifier l'IA pour les artisans.");
    expect(markdown).toContain("## Angles proposés");
    expect(markdown).toContain("| Angle survol |");
    expect(markdown).toContain("| 9/10 |");
    expect(markdown).toContain("## Script retenu — Angle profond");
    expect(markdown).toContain("« Et si vous perdiez de l'argent à chaque fois que vous croyez en gagner ? »");
    expect(markdown).toContain("### Scène 1 (15 s)");
    expect(markdown).toContain("### Scène 5 (10 s)");
    expect(markdown).toContain("**Direction visuelle** : Gros plan sur un visage surpris");
    expect(markdown).toContain("**Voix-off** : Première scène : la promesse en trois secondes.");
    expect(markdown).toContain("**Texte à l'écran** : LA VÉRITÉ");
    expect(markdown).toContain("**Appel à l'action** : Abonnez-vous pour la suite de l'enquête.");
    expect(markdown).toContain("**Durée totale estimée** : 100 s");
    expect(markdown).toContain("## Pack SEO");
    expect(markdown).toContain("### Titres alternatifs");
    expect(markdown).toContain("### Description");
    expect(markdown).toContain("### Mots-clés");
    expect(markdown).toContain("intelligence artificielle");
    expect(markdown).toContain("### Hashtags");
    expect(markdown).toContain("#ia #productivite #contenu");
    expect(markdown).toContain("### Concept de miniature");
    expect(markdown).toContain("Visage expressif sur fond contrasté");
  });

  it("échec du SEO (3e étape) : erreur française de format, rien n'est persisté", async () => {
    generateForUserMock
      .mockResolvedValueOnce(llmJson({ angles: ANGLES }))
      .mockResolvedValueOnce(llmJson(SCRIPT))
      .mockResolvedValue({ response: { text: "aucun json dans ce seo" } });

    await expect(
      contentPackageTool.execute({ brief: "Un brief de contenu valide et détaillé." }, CONTEXT),
    ).rejects.toThrow(/format attendu/);
    expect(generateForUserMock).toHaveBeenCalledTimes(4); // angles + script + 2 tentatives SEO
    expect(generateArtifactMock).not.toHaveBeenCalled();
    expect(storeArtifactBufferMock).not.toHaveBeenCalled();
  });
});
