import { WIZARD_AGENT_TYPES, wizardTypeForKey, type WizardAgentType } from "./charter";

/**
 * Création simplifiée d'agent Gen3ia : le formulaire ne demande QUE
 *  - le nom de l'agent ;
 *  - son type (agent de code, marketing, enseignement, commercial, vocal,
 *    ou un type personnalisé saisi librement) ;
 *  - un fichier mémoire optionnel (importé seulement si nécessaire).
 *
 * Tout le reste est déduit automatiquement du type : description, compétences,
 * outils déclarés, mode d'appel (vocal). La charte complète est générée par
 * le serveur (createAgentRecord). Fonctions pures, testables.
 */

/** Clés de types proposées dans la création simplifiée, dans l'ordre d'affichage. */
export const QUICK_CREATE_TYPE_KEYS = ["code", "marketing", "teaching", "sales", "voice", "custom"] as const;
export type QuickCreateTypeKey = (typeof QUICK_CREATE_TYPE_KEYS)[number];

export const QUICK_CREATE_TYPE_LABELS: Record<QuickCreateTypeKey, string> = {
  code: "Agent de code",
  marketing: "Marketing",
  teaching: "Enseignement",
  sales: "Commercial",
  voice: "Agent vocal",
  custom: "Personnalisé",
};

export function quickCreateTypeForKey(key: string): WizardAgentType | undefined {
  return wizardTypeForKey(key);
}

export interface QuickCreateInput {
  name: string;
  typeKey: string;
  /** Type personnalisé saisi par l'utilisateur (typeKey === "custom"). */
  customType?: string;
  memoryFile?: { path: string; name: string };
}

export interface QuickCreatePayload {
  name: string;
  description: string;
  type: WizardAgentType["baseType"];
  typeLabel: string;
  skills: string[];
  agentMode: "standard" | "call";
  tools: string[];
  status: "active";
  voiceEnabled: boolean;
  voiceConfig?: {
    language: "fr-FR";
    greeting: string;
    maxTurns: number;
    maxDurationSeconds: number;
    inboundEnabled: boolean;
    outboundEnabled: boolean;
    voiceEnabled: boolean;
  };
  memoryFile?: { path: string; name: string };
}

/** Construit le payload POST /api/agents depuis la saisie minimale. */
export function buildQuickCreatePayload(input: QuickCreateInput): QuickCreatePayload {
  const name = input.name.trim();
  const customType = input.customType?.trim() ?? "";
  const isCustom = input.typeKey === "custom";
  const typeEntry = wizardTypeForKey(input.typeKey) ?? wizardTypeForKey("custom")!;
  const typeLabel = isCustom ? (customType || "Personnalisé") : typeEntry.label;
  const agentMode = input.typeKey === "voice" ? ("call" as const) : ("standard" as const);
  const skills = isCustom ? [] : [...typeEntry.suggestedSkills];
  const description = isCustom
    ? `Agent Gen3ia spécialisé : ${typeLabel}.`
    : typeEntry.description;

  return {
    name,
    description,
    type: typeEntry.baseType,
    typeLabel,
    skills,
    agentMode,
    tools: [...typeEntry.declaredTools],
    status: "active",
    voiceEnabled: agentMode === "call",
    ...(agentMode === "call"
      ? {
          voiceConfig: {
            language: "fr-FR" as const,
            greeting: `Bonjour, je suis ${name}. Comment puis-je vous aider ?`,
            maxTurns: 20,
            maxDurationSeconds: 300,
            inboundEnabled: true,
            outboundEnabled: true,
            voiceEnabled: true,
          },
        }
      : {}),
    ...(input.memoryFile ? { memoryFile: input.memoryFile } : {}),
  };
}

/** Validation côté client (le serveur revalide toujours via zod). */
export function canSubmitQuickCreate(input: QuickCreateInput): boolean {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) return false;
  if (!QUICK_CREATE_TYPE_KEYS.includes(input.typeKey as QuickCreateTypeKey)) return false;
  if (input.typeKey === "custom" && (input.customType?.trim().length ?? 0) < 2) return false;
  return true;
}

/** Libellés des types, pour l'affichage (utilisé par les tests et l'UI). */
export function quickCreateTypeOptions(): Array<{ key: QuickCreateTypeKey; label: string; description: string }> {
  return QUICK_CREATE_TYPE_KEYS.map((key) => ({
    key,
    label: QUICK_CREATE_TYPE_LABELS[key],
    description: WIZARD_AGENT_TYPES.find((entry) => entry.key === key)?.description ?? "Définissez votre propre type d'agent.",
  }));
}
