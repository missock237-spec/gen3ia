import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { persistMarkdownDeliverable } from "./artifact-deliverable";
import { generateStructuredForUser } from "./llm-json";

/**
 * OUTIL AGENT « content.package » — Automated Content Pipeline Orchestrator (Task 140).
 *
 * D'une simple idée de contenu, produit le PACK COMPLET en trois étapes LLM
 * séquentielles :
 *  1. ANGLES (task « automation », 1500 tokens) : 3 à 5 angles éditoriaux
 *     avec accroche et engagement estimé ;
 *  2. SCRIPT (task « document », 3500 tokens) : script scène par scène du
 *     MEILLEUR angle (engagement maximal, départage déterministe au premier
 *     en cas d'égalité) — les directions visuelles sont directement
 *     utilisables comme prompts de génération d'images ;
 *  3. SEO (task « automation », 1200 tokens) : titres alternatifs,
 *     description, mots-clés, hashtags et concept de miniature.
 *
 * Le nombre de scènes visé dépend de la plateforme (TikTok/Instagram/X :
 * 6-10, YouTube/LinkedIn : 5-12, Blog : 4-8).
 *
 * Chaîne d'exécution (100 % production, aucune simulation) : chaque appel LLM
 * passe par generateStructuredForUser (wallet de l'utilisateur, relance
 * corrective), le rendu markdown français est déterministe, et le pack est
 * PERSISTÉ via persistMarkdownDeliverable (generateArtifact →
 * storeArtifactBuffer) — jamais un retour volatil.
 */

type ContentPlatform = "youtube" | "tiktok" | "instagram" | "linkedin" | "x" | "blog";
type ContentLanguage = "fr" | "en";

const ContentPackageInput = z.object({
  brief: z.string().min(10).max(4_000),
  platform: z.enum(["youtube", "tiktok", "instagram", "linkedin", "x", "blog"]).default("youtube"),
  tone: z.string().max(120).optional(),
  audience: z.string().max(300).optional(),
  language: z.enum(["fr", "en"]).default("fr"),
});

/** Fourchette de scènes visée selon la plateforme (contrat éditorial). */
export const CONTENT_SCENE_RANGES: Record<ContentPlatform, { min: number; max: number }> = {
  tiktok: { min: 6, max: 10 },
  instagram: { min: 6, max: 10 },
  x: { min: 6, max: 10 },
  youtube: { min: 5, max: 12 },
  linkedin: { min: 5, max: 12 },
  blog: { min: 4, max: 8 },
};

const PLATFORM_LABELS: Record<ContentPlatform, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X",
  blog: "Blog",
};

const ContentAnglesSchema = z.object({
  angles: z
    .array(
      z.object({
        title: z.string().max(150),
        hook: z.string().max(300),
        angle: z.string().max(500),
        estimatedEngagement: z.number().int().min(1).max(10),
      }),
    )
    .min(3)
    .max(5),
});

const ContentScriptSchema = z.object({
  hookLine: z.string().max(200),
  scenes: z
    .array(
      z.object({
        sceneNumber: z.number().int().min(1),
        visualDirection: z.string().max(600),
        voiceover: z.string().max(1_200),
        onScreenText: z.string().max(200).optional(),
        durationSeconds: z.number().int().min(3).max(60),
      }),
    )
    .min(4)
    .max(12),
  callToAction: z.string().max(300),
  totalDurationSeconds: z.number().int(),
});

const ContentSeoSchema = z.object({
  titles: z.array(z.string().max(120)).min(3).max(5),
  description: z.string().max(2_000),
  keywords: z.array(z.string().max(60)).max(20),
  hashtags: z.array(z.string().max(40)).max(15),
  thumbnailConcept: z.string().max(500),
});

export type ContentAngle = z.infer<typeof ContentAnglesSchema>["angles"][number];
export type ContentScript = z.infer<typeof ContentScriptSchema>;
export type ContentSeo = z.infer<typeof ContentSeoSchema>;

export interface ContentPack {
  angles: ContentAngle[];
  script: ContentScript;
  seo: ContentSeo;
}

/**
 * Meilleur angle : engagement maximal, PREMIER en cas d'égalité
 * (départage déterministe, jamais aléatoire).
 */
export function selectBestAngle(angles: ContentAngle[]): ContentAngle {
  return angles.reduce<ContentAngle>(
    (best, current) => (current.estimatedEngagement > best.estimatedEngagement ? current : best),
    angles[0],
  );
}

function languageLine(language: ContentLanguage): string {
  return language === "fr"
    ? "Rédige tout le contenu en FRANÇAIS."
    : "Write all content in ENGLISH.";
}

function contextLines(input: { platform: ContentPlatform; tone?: string; audience?: string }): string[] {
  const lines = [`Plateforme de publication : ${PLATFORM_LABELS[input.platform]}`];
  if (input.tone && input.tone.trim().length > 0) lines.push(`Tonalité souhaitée : ${input.tone.trim()}`);
  if (input.audience && input.audience.trim().length > 0) lines.push(`Audience visée : ${input.audience.trim()}`);
  return lines;
}

function buildAnglesSystemPrompt(language: ContentLanguage): string {
  return [
    "Tu es un stratège de contenu digital chevronné, spécialiste des angles éditoriaux qui performent sur toutes les plateformes.",
    "",
    "À partir du brief fourni, propose 3 à 5 angles éditoriaux réellement DISTINCTS (pas des variantes cosmétiques du même propos).",
    "Chaque angle porte : un « title » percutant, une « hook » (accroche des 3 premières secondes), une « angle » (description de l'intention éditoriale) et une « estimatedEngagement » honnête de 1 (faible) à 10 (excellent) au regard de la plateforme.",
    languageLine(language),
    "Réponds UNIQUEMENT avec un objet JSON valide : {\"angles\": [{\"title\": string, \"hook\": string, \"angle\": string, \"estimatedEngagement\": number (1-10)}]}",
  ].join("\n");
}

function buildScriptSystemPrompt(platform: ContentPlatform, language: ContentLanguage): string {
  const range = CONTENT_SCENE_RANGES[platform];
  return [
    "Tu es scénariste de contenus digitaux ET directeur artistique. Tu écris des scripts scène par scène dont les directions visuelles sont directement utilisables comme prompts de génération d'images : sujet précis, cadrage, ambiance, lumière, style.",
    "",
    `Écris le script complet de l'angle RETENU pour la plateforme ${PLATFORM_LABELS[platform]} : ${range.min} à ${range.max} scènes.`,
    "Chaque scène précise : une « visualDirection » (prompt visuel exploitable tel quel), une « voiceover » (texte dit à voix haute, oral et fluide), un « onScreenText » si pertinent (texte court affiché à l'écran) et une « durationSeconds » (entier, 3 à 60).",
    "Ajoute une « hookLine » d'ouverture (l'accroche des 3 premières secondes) et termine par une « callToAction » claire et actionnable.",
    languageLine(language),
    "Réponds UNIQUEMENT avec un objet JSON conforme au schéma : {\"hookLine\": string, \"scenes\": [{\"sceneNumber\": number, \"visualDirection\": string, \"voiceover\": string, \"onScreenText\": string (optionnel), \"durationSeconds\": number}], \"callToAction\": string, \"totalDurationSeconds\": number}",
  ].join("\n");
}

function buildSeoSystemPrompt(language: ContentLanguage): string {
  return [
    "Tu es expert SEO et packaging éditorial. Tu produis le pack SEO complet d'un contenu digital.",
    "",
    "Le pack contient : 3 à 5 « titles » alternatifs optimisés (incitatifs, sans clickbait mensonger), une « description » complète et structurée, des « keywords » (jusqu'à 20, du plus général au plus spécifique), des « hashtags » (jusqu'à 15, au format #motclé) et un « thumbnailConcept » (concept de miniature qui déclenche le clic).",
    languageLine(language),
    "Réponds UNIQUEMENT avec un objet JSON valide conforme au schéma attendu.",
  ].join("\n");
}

function buildAnglesUserPrompt(input: {
  brief: string;
  platform: ContentPlatform;
  tone?: string;
  audience?: string;
}): string {
  return ["Brief de contenu :", "", input.brief, "", ...contextLines(input)].join("\n");
}

function buildScriptUserPrompt(
  input: { brief: string; platform: ContentPlatform; tone?: string; audience?: string },
  selectedAngle: ContentAngle,
): string {
  return [
    "Brief de contenu :",
    "",
    input.brief,
    "",
    ...contextLines(input),
    "",
    `Angle RETENU (meilleur engagement estimé : ${selectedAngle.estimatedEngagement}/10) :`,
    `- Titre : ${selectedAngle.title}`,
    `- Accroche : ${selectedAngle.hook}`,
    `- Angle : ${selectedAngle.angle}`,
    "",
    "Écris le script scène par scène de cet angle retenu.",
  ].join("\n");
}

function buildSeoUserPrompt(input: { brief: string }, selectedAngle: ContentAngle, script: ContentScript): string {
  return [
    "Brief de contenu :",
    "",
    input.brief,
    "",
    "Contenu retenu :",
    `- Angle : ${selectedAngle.title} — ${selectedAngle.hook}`,
    `- Accroche d'ouverture du script : ${script.hookLine}`,
    `- Appel à l'action final : ${script.callToAction}`,
    "",
    "Produis le pack SEO de ce contenu.",
  ].join("\n");
}

/** Échappe une cellule de tableau markdown (| et sauts de ligne). */
function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Rendu markdown français déterministe du pack de contenu complet. */
export function renderContentPackageMarkdown(params: {
  platform: ContentPlatform;
  brief: string;
  angles: ContentAngle[];
  selectedAngle: ContentAngle;
  script: ContentScript;
  seo: ContentSeo;
}): string {
  const { platform, brief, angles, selectedAngle, script, seo } = params;
  const lines: string[] = [];

  lines.push(`# Pack de contenu — ${PLATFORM_LABELS[platform]}`);
  lines.push("");
  lines.push("## Brief");
  lines.push("");
  lines.push(brief.trim() || "—");
  lines.push("");
  lines.push("## Angles proposés");
  lines.push("");
  lines.push("| Angle | Accroche | Engagement estimé |");
  lines.push("| --- | --- | --- |");
  for (const angle of angles) {
    lines.push(`| ${tableCell(angle.title)} | ${tableCell(angle.hook)} | ${angle.estimatedEngagement}/10 |`);
  }
  lines.push("");
  lines.push(`## Script retenu — ${selectedAngle.title}`);
  lines.push("");
  lines.push(`Accroche d'ouverture : « ${script.hookLine} »`);
  lines.push("");

  const scenes = [...script.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  for (const scene of scenes) {
    lines.push(`### Scène ${scene.sceneNumber} (${scene.durationSeconds} s)`);
    lines.push("");
    lines.push(`**Direction visuelle** : ${scene.visualDirection}`);
    lines.push("");
    lines.push(`**Voix-off** : ${scene.voiceover}`);
    if (scene.onScreenText !== undefined && scene.onScreenText.trim().length > 0) {
      lines.push("");
      lines.push(`**Texte à l'écran** : ${scene.onScreenText}`);
    }
    lines.push("");
  }

  lines.push(`**Appel à l'action** : ${script.callToAction}`);
  lines.push("");
  lines.push(`**Durée totale estimée** : ${script.totalDurationSeconds} s`);
  lines.push("");
  lines.push("## Pack SEO");
  lines.push("");
  lines.push("### Titres alternatifs");
  lines.push("");
  for (const title of seo.titles) lines.push(`- ${title}`);
  lines.push("");
  lines.push("### Description");
  lines.push("");
  lines.push(seo.description.trim() || "—");
  lines.push("");
  lines.push("### Mots-clés");
  lines.push("");
  lines.push(seo.keywords.length > 0 ? seo.keywords.join(", ") : "—");
  lines.push("");
  lines.push("### Hashtags");
  lines.push("");
  lines.push(seo.hashtags.length > 0 ? seo.hashtags.join(" ") : "—");
  lines.push("");
  lines.push("### Concept de miniature");
  lines.push("");
  lines.push(seo.thumbnailConcept.trim() || "—");
  lines.push("");
  return lines.join("\n");
}

export interface ContentPackageResult {
  pack: ContentPack;
  artifactId: string;
  filename: string;
}

export const contentPackageTool: ToolDefinition<z.infer<typeof ContentPackageInput>, ContentPackageResult> = {
  id: "content.package",
  name: "Automated Content Pipeline Orchestrator",
  description:
    "From a single content idea, orchestrate the full production pack: 3-5 editorial angles with estimated engagement, a scene-by-scene video script of the best angle (visual directions ready to use as image prompts, platform-tuned scene count) and a complete SEO pack (titles, description, keywords, hashtags, thumbnail concept) — persisted as a real markdown deliverable.",
  category: "media",
  risk: "medium",
  inputSchema: ContentPackageInput,
  async execute(input, context) {
    const parsed = ContentPackageInput.parse(input);

    // ── 1/3 ANGLES ──────────────────────────────────────────────────────
    const anglesResult = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "automation",
      system: buildAnglesSystemPrompt(parsed.language),
      user: buildAnglesUserPrompt(parsed),
      schema: ContentAnglesSchema,
      maxTokens: 1_500,
    });

    // ── 2/3 SCRIPT du meilleur angle ────────────────────────────────────
    const selectedAngle = selectBestAngle(anglesResult.angles);
    const scriptResult = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "document",
      system: buildScriptSystemPrompt(parsed.platform, parsed.language),
      user: buildScriptUserPrompt(parsed, selectedAngle),
      schema: ContentScriptSchema,
      maxTokens: 3_500,
    });

    // ── 3/3 SEO ────────────────────────────────────────────────────────
    const seoResult = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "automation",
      system: buildSeoSystemPrompt(parsed.language),
      user: buildSeoUserPrompt({ brief: parsed.brief }, selectedAngle, scriptResult),
      schema: ContentSeoSchema,
      maxTokens: 1_200,
    });

    // Déterminisme : scènes triées par numéro côté rendu ET retour.
    const scenes = [...scriptResult.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
    const script: ContentScript = { ...scriptResult, scenes };
    const pack: ContentPack = { angles: anglesResult.angles, script, seo: seoResult };

    const markdown = renderContentPackageMarkdown({
      platform: parsed.platform,
      brief: parsed.brief,
      angles: pack.angles,
      selectedAngle,
      script: pack.script,
      seo: pack.seo,
    });

    const deliverable = await persistMarkdownDeliverable({
      userId: context.userId,
      executionId: context.executionId,
      title: `Pack de contenu — ${PLATFORM_LABELS[parsed.platform]}`,
      markdown,
    });

    return {
      pack,
      artifactId: deliverable.artifactId,
      filename: deliverable.filename,
    };
  },
};
