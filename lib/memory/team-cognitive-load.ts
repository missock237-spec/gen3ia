import "server-only";

import { requireTeamFeatureAccess } from "@/lib/team/feature-access";

export interface CognitiveMemoryItem { id: string; text: string; importance?: number; tags?: string[]; source?: string; }
export interface CognitiveWorkspace { objective?: string; memories?: CognitiveMemoryItem[]; recentMessages?: Array<{ role: string; content: string }>; decisions?: string[]; constraints?: string[]; }
export interface CognitiveLoadResult { teamId: string; prioritizedContext: string[]; decisions: string[]; constraints: string[]; nextActions: string[]; omittedMemoryIds: string[]; compressionRatio: number; }

const MAX_CONTEXT_ITEMS = 18;
const clean = (value: unknown, max = 1200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const unique = (values: string[]) => { const seen = new Set<string>(); return values.filter((v) => { const k = v.toLocaleLowerCase(); if (!v || seen.has(k)) return false; seen.add(k); return true; }); };
// Deduplicates across categories: "CONTRAINTE: X" and "MÉMOIRE: X" carry the same
// information, so only the highest-priority occurrence is kept.
const semanticUnique = (values: string[]) => { const seen = new Set<string>(); return values.filter((v) => { const k = v.replace(/^[^:]+:\s*/, "").toLocaleLowerCase(); if (!v || seen.has(k)) return false; seen.add(k); return true; }); };

export async function reduceTeamCognitiveLoad(input: { userId: string; teamId: string; workspace: CognitiveWorkspace }): Promise<CognitiveLoadResult> {
  await requireTeamFeatureAccess({ userId: input.userId, teamId: input.teamId, feature: "memory" });
  const memories = (input.workspace.memories ?? []).map((m) => ({ ...m, text: clean(m.text), importance: Math.max(0, Math.min(1, Number(m.importance ?? 0.5))) })).filter((m) => m.text).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const objective = clean(input.workspace.objective, 1500);
  const messages = (input.workspace.recentMessages ?? []).map((m) => `${clean(m.role, 40)}: ${clean(m.content)}`).filter(Boolean).slice(-8);
  const decisions = unique((input.workspace.decisions ?? []).map((v) => clean(v, 600))).slice(0, 6);
  const constraints = unique((input.workspace.constraints ?? []).map((v) => clean(v, 600))).slice(0, 6);
  const selected = memories.slice(0, MAX_CONTEXT_ITEMS);
  const prioritizedContext = semanticUnique([objective ? `OBJECTIF: ${objective}` : "", ...decisions.map((v) => `DÉCISION: ${v}`), ...constraints.map((v) => `CONTRAINTE: ${v}`), ...selected.map((m) => `MÉMOIRE: ${m.text}`), ...messages.map((m) => `RÉCENT: ${m}`)]).slice(0, MAX_CONTEXT_ITEMS + 14);
  const nextActions = unique([...selected.filter((m) => m.tags?.some((tag) => /next|todo|action/i.test(tag))).map((m) => m.text), ...messages.filter((m) => /todo|next|action|à faire|prochaine/i.test(m)).map((m) => m.replace(/^\w+:\s*/, ""))]).slice(0, 6);
  const omittedMemoryIds = memories.slice(MAX_CONTEXT_ITEMS).map((m) => m.id).filter(Boolean);
  const sourceCount = Math.max(1, memories.length + messages.length + decisions.length + constraints.length + (objective ? 1 : 0));
  return { teamId: input.teamId, prioritizedContext, decisions, constraints, nextActions, omittedMemoryIds, compressionRatio: Math.min(1, prioritizedContext.length / sourceCount) };
}
