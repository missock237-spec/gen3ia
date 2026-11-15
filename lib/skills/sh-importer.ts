import "server-only";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SkillDefinitionInput } from "./schema";
import { saveSkill } from "./repository";

/**
 * Importateur skills.sh (écosystème ouvert Vercel Labs / Anthropic).
 *
 * Les skills du registre skills.sh sont des fichiers SKILL.md au format
 * « Agent Skills » : frontmatter YAML (name, description) + corps Markdown
 * (instructions procédurales). Ce module :
 *  1. lit le catalogue local `lib/skills/catalog/<name>/SKILL.md`
 *     (instantané committé des skills curatées — aucune dépendance réseau
 *     au démarrage) ;
 *  2. convertit chaque SKILL.md en SkillDefinitionInput (schéma plateforme) ;
 *  3. enrichit les triggers de synonymes FRANÇAIS (les utilisateurs Gen3ia
 *     écrivent en français — le scoring lexical de la sélection automatique
 *     doit les reconnaître) ;
 *  4. upsert en base R2 (id `sh_<name>`, idempotent : le même contenu ne
 *     crée jamais de doublon).
 *
 * Idempotence : `version` dérivée d'un hash du contenu — re-importer un
 * SKILL.md inchangé n'écrit rien.
 */

const CATALOG_DIR = path.join(process.cwd(), "lib", "skills", "catalog");

/** Prefixe d'identifiant pour les skills importées de skills.sh. */
export const SKILLS_SH_ID_PREFIX = "sh_";

/** Longueur max des instructions conservées (le pont runtime borne à 4 000). */
const MAX_INSTRUCTION_CHARS = 3_600;

/** Longueur max du texte de description conservé. */
const MAX_DESCRIPTION_CHARS = 1_000;

/** Sources officielles (traçabilité, affichage, mises à jour futures). */
const SOURCES: Record<string, { repo: string; category: string }> = {
  "web-design-guidelines": { repo: "vercel-labs/agent-skills", category: "design" },
  "react-best-practices": { repo: "vercel-labs/agent-skills", category: "code" },
  "writing-guidelines": { repo: "vercel-labs/agent-skills", category: "writing" },
  "frontend-design": { repo: "anthropics/skills", category: "design" },
  "code-review": { repo: "mattpocock/skills", category: "code" },
  tdd: { repo: "mattpocock/skills", category: "code" },
  "domain-modeling": { repo: "mattpocock/skills", category: "code" },
  "diagnosing-bugs": { repo: "mattpocock/skills", category: "code" },
  prototype: { repo: "mattpocock/skills", category: "code" },
  research: { repo: "mattpocock/skills", category: "research" },
  triage: { repo: "mattpocock/skills", category: "code" },
  implement: { repo: "mattpocock/skills", category: "code" },
  teach: { repo: "mattpocock/skills", category: "productivity" },
  handoff: { repo: "mattpocock/skills", category: "productivity" },
  "agent-browser": { repo: "101-skills/superpowers", category: "web" },
  "remotion-render": { repo: "101-skills/superpowers", category: "media" },
};

/**
 * Synonymes français par catégorie — la sélection automatique (scoring
 * lexical) doit matcher les demandes françaises (« corrige ce bug » doit
 * activer diagnosing-bugs, « génère une vidéo » → ai-video-generation…).
 */
const FR_TRIGGERS: Record<string, string[]> = {
  code: ["code", "bug", "erreur", "corrige", "corriger", "developpe", "développe", "fonction", "composant", "test", "tests", "refactorise", "architecture", "script", "application", "api", "typescript", "javascript", "react", "nextjs", "programmation"],
  design: ["design", "interface", "ui", "ux", "maquette", "page", "site", "web", "visuel", "couleur", "typographie", "accessibilite", "accessibilité", "responsive"],
  writing: ["redige", "rédige", "redaction", "rédaction", "ecrit", "écrit", "texte", "article", "documentation", "docs", "prose", "style", "message", "mail", "email"],
  research: ["recherche", "cherche", "trouve", "trouve-moi", "informe", "informe-toi", "analyse", "compare", "sources", "enquete", "enquête", "etudie", "étudie", "synthese", "synthèse"],
  media: ["video", "vidéo", "videos", "vidéos", "image", "images", "photo", "audio", "voix", "voix-off", "son", "musique", "montage", "avatar", "animation", "generer", "générer"],
  web: ["navigateur", "browser", "scrape", "extrait", "extrait le contenu", "page web", "site internet", "automatise", "automatiser"],
  productivity: ["explique", "enseigne", "apprendre", "tutoriel", "comprendre", "resume", "résume", "planifie", "organise", "methode", "méthode"],
};

/** Extrait le frontmatter YAML minimal (name, description) sans dépendance. */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    const lines = raw.split(/\r?\n/);
    const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? "skill";
    return { name: title, description: title, body: raw };
  }
  const [, frontmatter, body] = match;
  const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter);
  const descriptionMatch = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))$/m.exec(frontmatter);
  return {
    name: (nameMatch?.[1] ?? "").trim() || "skill",
    description: (descriptionMatch?.[1] ?? descriptionMatch?.[2] ?? descriptionMatch?.[3] ?? "").trim(),
    body: body.trim(),
  };
}

/** Version courte et stable dérivée du contenu (idempotence d'import). */
function contentVersion(content: string): number {
  let hash = 0;
  for (let i = 0; i < content.length; i += 1) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 900_000 + 1_000;
}

/** Extrait les triggers EN du champ description (« Use when ... »). */
function englishTriggers(description: string, name: string): string[] {
  const lower = description.toLowerCase();
  const triggers = new Set<string>();
  const useWhen = /use when ([^.]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = useWhen.exec(description)) !== null) {
    for (const part of match[1].split(/,| or /i)) {
      const trigger = part.replace(/["“”]/g, "").trim().toLowerCase();
      if (trigger.length >= 3 && trigger.length <= 60) triggers.add(trigger);
    }
  }
  for (const word of lower.split(/[^a-z]+/)) {
    if (word.length >= 5) triggers.add(word);
  }
  triggers.add(name.toLowerCase());
  return [...triggers].slice(0, 40);
}

export interface ImportedSkill {
  id: string;
  name: string;
  version: number;
  /** true = contenu inchangé, aucune écriture. */
  skipped: boolean;
}

/** Convertit un SKILL.md brut en définition de skill plateforme. */
export function convertSkillMarkdown(name: string, raw: string): SkillDefinitionInput {
  const { name: fmName, description, body } = parseFrontmatter(raw);
  const source = SOURCES[name] ?? { repo: "skills.sh", category: "general" };
  const skillName = fmName || name;
  const frTriggers = FR_TRIGGERS[source.category] ?? [];
  const instructions = body.length > MAX_INSTRUCTION_CHARS ? `${body.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[Skill tronquée — source complète : skills.sh/${source.repo}#${name}]` : body;
  const version = contentVersion(raw);
  const now = new Date().toISOString();

  return {
    id: `${SKILLS_SH_ID_PREFIX}${name}`,
    name: skillName,
    description: description.length > MAX_DESCRIPTION_CHARS ? description.slice(0, MAX_DESCRIPTION_CHARS) : description || skillName,
    version,
    category: source.category,
    capabilities: [
      { name: source.category, description: `Domaine : ${source.category} (skill skills.sh ${source.repo}).` },
      { name: "procedural-knowledge", description: "Instructions procédurales éprouvées applicables à la mission." },
    ],
    inputs: [{ name: "mission", type: "string", description: "Demande de l'utilisateur.", required: true }],
    outputs: [{ name: "resultat", type: "object", description: "Réponse produite en appliquant la skill." }],
    triggers: [...new Set([...englishTriggers(description, name), ...frTriggers])].slice(0, 60),
    requiredTools: [],
    compatibleTasks: ["*"],
    systemInstructions: `Skill « ${skillName} » importée de skills.sh (${source.repo}). Applique ces instructions procédurales à la mission en cours.`,
    executionInstructions: instructions,
    evaluationCriteria: ["respect des instructions de la skill", "qualité du résultat appliqué"],
    status: "active",
    visibility: "system",
    authorId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Importe tout le catalogue local en base (idempotent).
 * Retourne la liste des skills importées (skipped = contenu inchangé).
 */
export async function importSkillsShCatalog(): Promise<ImportedSkill[]> {
  const entries = await readdir(CATALOG_DIR, { withFileTypes: true });
  const imported: ImportedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(CATALOG_DIR, entry.name, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const definition = convertSkillMarkdown(entry.name, raw);
    const result = await saveSkill(definition);
    imported.push({ id: definition.id, name: definition.name, version: definition.version, skipped: !result.created && !result.updated });
  }

  return imported;
}
