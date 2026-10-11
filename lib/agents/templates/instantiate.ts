import { HttpError } from "@/lib/security/http-errors";
import { createAgent } from "@/lib/agents/factory";
import { createAgentRecord } from "@/lib/agents/repository";
import type { AgentRecord } from "@/lib/agents/schema";
import { newUlid } from "@/lib/storage/user-data-store";
import { getTemplate, type AgentTemplate } from "./index";

/**
 * TEMPLATES D'AGENTS SECTORIELS — instanciation (Task 132, module SERVEUR).
 *
 * CHAÎNE D'INSTANCIATION (contractuelle) :
 *  1. la FABRIQUE (lib/agents/factory.ts — createAgent) assemble l'agent de
 *     base : nom préfixé, description, prompt système (persona + amorces de
 *     connaissances), outils autorisés, compétences, itérations ;
 *  2. le DÉPÔT (lib/agents/repository.ts — createAgentRecord) persiste
 *     l'enregistrement APRÈS revalidation complète par AgentRecordSchema
 *     (zod) : AUCUNE validation n'est contournée, et le garde
 *     organisationnel (assertOrgAttach) s'applique quand orgId est fourni.
 *
 * Les agents instanciés démarrent « active » (prêts à l'emploi) et restent
 * PERSONNELS par défaut (pas de rattachement projet automatique : c'est une
 * décision utilisateur dans le Studio).
 */

/** Surcharges autorisées à l'instanciation d'un template. */
export interface InstantiateTemplateOverrides {
  /** Nom de l'agent (remplace le nom par défaut « Agent <template> »). */
  name?: string;
  /** Description de l'agent (remplace celle du template). */
  description?: string;
  /** Organisation cible (l'appelant doit en être membre — garde du dépôt). */
  orgId?: string;
}

/**
 * Nom de l'agent instancié : « Agent <nom du template> » par défaut
 * (préfixe assumant l'origine), remplacé tel quel par la surcharge.
 * Normalisé proprement (espaces, longueur ≤ 80 — borne AgentRecordSchema).
 */
export function agentNameFromTemplate(template: AgentTemplate, customName?: string): string {
  const base = (customName?.trim() || `Agent ${template.nom}`).replace(/\s+/g, " ").trim();
  if (base.length <= 80) return base;
  return `${base.slice(0, 79).trimEnd()}…`;
}

/**
 * Prompt système complet du template : persona + amorces de connaissances
 * (l'agent démarre avec ces repères métier sans exiger de mémoire importée).
 */
export function buildTemplateSystemPrompt(template: AgentTemplate): string {
  const amorces = template.amorcesConnaissances.length
    ? `\n\nAMORCES DE CONNAISSANCE :\n${template.amorcesConnaissances.map((amorce) => `- ${amorce}`).join("\n")}`
    : "";
  return `${template.persona}${amorces}`;
}

/**
 * Instancie un template sectoriel pour un utilisateur : fabrique → dépôt
 * validant. Lève HttpError 401 (non authentifié) ou 404 (template inconnu).
 */
export async function instantiateFromTemplate(
  userId: string,
  templateId: string,
  overrides?: InstantiateTemplateOverrides,
): Promise<AgentRecord> {
  if (!userId?.trim()) throw new HttpError(401, "Authentification requise.");
  const template = getTemplate(templateId);
  if (!template) throw new HttpError(404, "Template sectoriel introuvable.");

  const name = agentNameFromTemplate(template, overrides?.name);
  const description = (overrides?.description?.trim() || template.description).slice(0, 500);
  const systemPrompt = buildTemplateSystemPrompt(template);

  // 1) FABRIQUE : assemblage de l'agent de base. `projectId` est un champ
  //    structurel exigé par la fabrique ; l'enregistrement final reste un
  //    agent personnel (projectId optionnel côté dépôt).
  const base = createAgent({
    id: newUlid(),
    projectId: "",
    ownerId: userId,
    name,
    description,
    systemPrompt,
    autonomous: true,
    maxIterations: template.preferencesModele.maxIterations,
    skills: template.competences,
    tools: template.outilsAutorises,
  });

  // 2) DÉPÔT : persistance APRÈS revalidation zod complète (createAgentRecord
  //    parse l'entrée via AgentRecordSchema — aucune validation contournée).
  return createAgentRecord(
    userId,
    {
      name: base.name,
      description: base.description,
      type: template.typeAgent,
      typeLabel: `Template sectoriel — ${template.secteur}`.slice(0, 80),
      skills: base.skills,
      agentMode: "standard",
      systemPrompt: base.systemPrompt,
      modelStrategy: template.preferencesModele.strategie,
      temperature: template.preferencesModele.temperature,
      maxIterations: base.maxIterations,
      tools: base.tools,
      autonomous: base.autonomous,
      status: "active",
    },
    overrides?.orgId?.trim() ? { orgId: overrides.orgId.trim() } : undefined,
  );
}
