import { z } from "zod";

export const AGENT_TYPES = ["universal", "code", "content", "research", "automation"] as const;
export const VOICE_LANGUAGES = ["fr-FR", "en-US", "en-GB", "es-ES", "de-DE"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const VoiceConfigSchema = z.object({
  language: z.enum(VOICE_LANGUAGES).default("fr-FR"),
  greeting: z.string().trim().min(2).max(800).default("Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?"),
  maxTurns: z.number().int().min(1).max(40).default(20),
  maxDurationSeconds: z.number().int().min(30).max(1800).default(300),
  inboundEnabled: z.boolean().default(true),
  outboundEnabled: z.boolean().default(true),
  voiceEnabled: z.boolean().default(true),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_TYPE_META: Record<AgentType, { label: string; description: string; securityLevel: "safe" | "standard" | "power" }> = {
  universal: { label: "Universel", description: "Agent polyvalent : raisonnement, recherche web et production de documents.", securityLevel: "standard" },
  code: { label: "Agent de code", description: "Agent developpeur : execution de code sandboxee + Atelier d'Interfaces (21st.dev) exclusif.", securityLevel: "power" },
  content: { label: "Contenu", description: "Redaction, marketing, generation de documents et publications.", securityLevel: "standard" },
  research: { label: "Recherche", description: "Veille, analyse de marche et synthese documentaire via recherche web.", securityLevel: "standard" },
  automation: { label: "Automatisation", description: "Workflows repetitifs, planification et orchestration d'outils.", securityLevel: "standard" },
};

export const AgentRecordSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(""),
  type: z.enum(AGENT_TYPES).default("universal"),
  // Libellé métier choisi par l'utilisateur dans le wizard (prédéfini ou
  // type personnalisé). Pilote la charte de périmètre de l'agent.
  typeLabel: z.string().trim().min(1).max(80).optional(),
  // Compétences déclarées par l'utilisateur (au moins une côté wizard).
  skills: z.array(z.string().trim().min(1).max(80)).max(24).default([]),
  // Nature de l'agent : standard (chat) ou appel (voix/téléphonie).
  agentMode: z.enum(["standard", "call"]).default("standard"),
  // Fichier mémoire optionnel associé à l'agent (stockage Gen3ia).
  memoryFile: z.object({
    path: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(255),
  }).optional(),
  projectId: z.string().trim().min(1).max(128).optional(),
  // Optionnel : sans prompt saisi, la charte professionnelle est générée
  // automatiquement côté serveur (lib/agents/charter.ts).
  systemPrompt: z.string().trim().max(20_000).optional(),
  modelStrategy: z.enum(["automatic", "fixed"]).default("automatic"),
  preferredProvider: z.string().trim().max(60).optional(),
  preferredModel: z.string().trim().max(160).optional(),
  autonomous: z.boolean().default(true),
  maxIterations: z.number().int().min(1).max(20).default(8),
  tools: z.array(z.string().trim().max(160)).max(50).default([]),
  memoryEnabled: z.boolean().default(true),
  webResearchEnabled: z.boolean().default(true),
  documentGenerationEnabled: z.boolean().default(true),
  voiceEnabled: z.boolean().default(false),
  voiceConfig: VoiceConfigSchema.optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).default("active"),
});

export type AgentRecordInput = z.input<typeof AgentRecordSchema>;
export type AgentRecord = z.infer<typeof AgentRecordSchema> & { id: string; ownerId: string; createdAt: string; updatedAt: string };

export type AgentSummary = Pick<AgentRecord,
  "id" | "name" | "description" | "type" | "typeLabel" | "skills" | "agentMode" | "memoryFile" |
  "projectId" | "status" | "modelStrategy" |
  "preferredProvider" | "preferredModel" | "autonomous" | "maxIterations" | "tools" |
  "memoryEnabled" | "webResearchEnabled" | "documentGenerationEnabled" | "voiceEnabled" |
  "voiceConfig" | "createdAt" | "updatedAt"
>;
