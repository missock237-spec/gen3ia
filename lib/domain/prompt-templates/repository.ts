import "server-only";

import {
  listJson,
  newUlid,
  readJsonIfExists,
  removeKey,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

/**
 * Task 141 — bibliothèque de PROMPT TEMPLATES par utilisateur.
 *
 * « Utilisation simple et flexible » : chaque utilisateur peut enregistrer
 * ses propres formulations réutilisables (rapport hebdo, veille, analyse…)
 * puis les rappeler dans n'importe quel composer via la commande « /modèle ».
 *
 * Backend identique aux autres données utilisateur (Task 109) : clé canonique
 * `users/{uid}/prompt-templates/{templateId}.json`, templateId = ULID
 * (tri lexicographique des clés = ordre chronologique). Aucune clé globale,
 * aucun scan cross-tenant possible.
 */

/** Segment préfixe des templates sous l'espace utilisateur. */
const TEMPLATES_SEGMENT = "prompt-templates";

export interface PromptTemplate {
  id: string;
  userId: string;
  title: string;
  /** Corps du template inséré tel quel dans le composer. */
  body: string;
  createdAt: string;
  updatedAt: string;
}

type PromptTemplateDoc = Record<string, unknown> & { id?: string };

const MAX_TEMPLATES_PER_USER = 50;
const TITLE_MAX = 80;
const BODY_MAX = 4_000;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function templateFrom(userId: string, id: string, doc: PromptTemplateDoc): PromptTemplate | null {
  const title = str(doc.title).trim();
  const body = str(doc.body);
  // Document illisible/incomplet : ignoré (liste partielle, jamais de crash).
  if (!title || !body) return null;
  return {
    id,
    userId,
    title: title.slice(0, TITLE_MAX),
    body,
    createdAt: str(doc.createdAt),
    updatedAt: str(doc.updatedAt, str(doc.createdAt)),
  };
}

/** Liste les templates de l'utilisateur, les plus récents en premier. */
export async function listPromptTemplates(userId: string): Promise<PromptTemplate[]> {
  const docs = await listJson<PromptTemplateDoc>(userDir(userId, TEMPLATES_SEGMENT));
  const templates: PromptTemplate[] = [];
  for (const doc of docs) {
    const id = str(doc.id);
    if (!id) continue;
    const template = templateFrom(userId, id, doc);
    if (template) templates.push(template);
  }
  return templates.reverse();
}

export async function getPromptTemplate(userId: string, templateId: string): Promise<PromptTemplate | null> {
  const doc = await readJsonIfExists<PromptTemplateDoc>(userKey(userId, TEMPLATES_SEGMENT, templateId));
  if (!doc) return null;
  return templateFrom(userId, templateId, doc);
}

/** Crée (ou met à jour si templateId fourni) un template de l'utilisateur. */
export async function savePromptTemplate(
  userId: string,
  input: { title: string; body: string; templateId?: string },
): Promise<PromptTemplate> {
  const title = input.title.trim().slice(0, TITLE_MAX);
  const body = input.body.trim().slice(0, BODY_MAX);
  if (!title) throw new Error("Le titre du modèle est requis.");
  if (!body) throw new Error("Le contenu du modèle est requis.");

  const existing = input.templateId ? await getPromptTemplate(userId, input.templateId) : null;
  const now = new Date().toISOString();
  const id = existing?.id ?? newUlid();

  if (!existing) {
    // Garde de volume : la bibliothèque personnelle reste bornée (50 max).
    const current = await listPromptTemplates(userId);
    if (current.length >= MAX_TEMPLATES_PER_USER) {
      throw new Error(`Bibliothèque pleine (${MAX_TEMPLATES_PER_USER} modèles maximum) — supprimez-en un avant d'enregistrer.`);
    }
  }

  const template: PromptTemplate = {
    id,
    userId,
    title,
    body,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeJson(userKey(userId, TEMPLATES_SEGMENT, id), { v: 1, ...template, ulid: id });
  return template;
}

/** Supprime un template — retourne false s'il n'existait pas. */
export async function deletePromptTemplate(userId: string, templateId: string): Promise<boolean> {
  const existing = await getPromptTemplate(userId, templateId);
  if (!existing) return false;
  await removeKey(userKey(userId, TEMPLATES_SEGMENT, templateId));
  return true;
}
