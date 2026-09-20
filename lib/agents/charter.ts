import { AGENT_TYPE_META, type AgentType } from "./schema";

/**
 * Catalogue des types d'agents proposés dans l'assistant de personnalisation
 * du Studio. Chaque entrée définit :
 *  - baseType : le type technique (enum existant) qui pilote le niveau de
 *    sécurité du runtime (AGENT_TYPE_META.securityLevel) ;
 *  - label : le libellé métier affiché à l'utilisateur et injecté dans la
 *    charte de l'agent ;
 *  - suggestedSkills : compétences proposées en un clic dans le wizard.
 * Le module est volontairement pur (aucune dépendance serveur) afin d'être
 * partagé entre le wizard client, le charter serveur et les tests.
 */

export interface WizardAgentType {
  key: string;
  baseType: AgentType;
  label: string;
  description: string;
  suggestedSkills: string[];
  /** Outils métier déclarés à la création (s'ajoutent à la whitelist du niveau). */
  declaredTools: string[];
}

export const WIZARD_AGENT_TYPES: WizardAgentType[] = [
  {
    key: "code",
    baseType: "code",
    label: "Développement & Code",
    description: "Agent développeur : écrit, corrige et exécute du code, crée des interfaces.",
    suggestedSkills: ["JavaScript/TypeScript", "React & Next.js", "Débogage", "API REST", "Revue de code"],
    declaredTools: ["code.execute", "artifact.create"],
  },
  {
    key: "marketing",
    baseType: "content",
    label: "Marketing",
    description: "Stratégie de campagne, SEO, copywriting et analyse d'audience.",
    suggestedSkills: ["Stratégie de campagne", "SEO", "Copywriting", "Analyse d'audience", "Email marketing"],
    declaredTools: ["web.search", "artifact.create"],
  },
  {
    key: "research",
    baseType: "research",
    label: "Recherche & Analyse",
    description: "Veille concurrentielle, synthèse documentaire et analyse de données.",
    suggestedSkills: ["Veille concurrentielle", "Synthèse documentaire", "Analyse de données", "Rédaction de rapports"],
    declaredTools: ["web.search"],
  },
  {
    key: "content",
    baseType: "content",
    label: "Création de contenu",
    description: "Rédaction d'articles, posts réseaux sociaux, scripts et storytelling.",
    suggestedSkills: ["Rédaction web", "Storytelling", "Posts réseaux sociaux", "Script vidéo", "Correction"],
    declaredTools: ["web.search", "artifact.create"],
  },
  {
    key: "automation",
    baseType: "automation",
    label: "Automatisation",
    description: "Workflows répétitifs, planification et orchestration d'outils.",
    suggestedSkills: ["Workflows", "Intégrations d'applications", "Planification", "Documentation de processus"],
    declaredTools: ["web.search", "artifact.create"],
  },
  {
    key: "universal",
    baseType: "universal",
    label: "Assistant polyvalent",
    description: "Raisonnement général, recherche web et production de documents.",
    suggestedSkills: ["Raisonnement", "Recherche web", "Documents professionnels", "Résumés"],
    declaredTools: ["web.search", "artifact.create"],
  },
  {
    key: "custom",
    baseType: "universal",
    label: "Autre (à préciser)",
    description: "Définissez votre propre type d'agent : juridique, immobilier, RH, finance…",
    suggestedSkills: [],
    declaredTools: ["web.search", "artifact.create"],
  },
];

export function wizardTypeForKey(key: string): WizardAgentType | undefined {
  return WIZARD_AGENT_TYPES.find((entry) => entry.key === key);
}

/**
 * Libellé métier effectif d'un agent : le typeLabel saisi par l'utilisateur
 * (pré défini ou personnalisé) prime, sinon le libellé du type technique.
 */
export function labelForAgent(agent: { type: string; typeLabel?: string }): string {
  const custom = agent.typeLabel?.trim();
  if (custom) return custom;
  return AGENT_TYPE_META[agent.type as AgentType]?.label ?? "Assistant IA";
}

export interface AgentCharterInput {
  name: string;
  description: string;
  type: string;
  typeLabel?: string;
  skills?: string[];
  agentMode?: "standard" | "call";
  memoryFile?: { path: string; name: string };
}

const PROFESSIONAL_CONDUCT = [
  "RÈGLES DE CONDUITE PROFESSIONNELLE (obligatoires) :",
  "- Tes réponses sont rédigées dans un français clair, précis et professionnel : pas de jargon inutile, pas de familiarité, jamais de texte approximatif.",
  "- Tu structures systématiquement tes réponses : phrases courtes, paragraphes aérés, listes à puces ou étapes numérotées quand cela aide la lecture.",
  "- Tu es factuel et rigoureux : si une information manque pour bien répondre, tu poses UNE question de clarification ciblée au lieu d'inventer.",
  "- Tu vas droit au but : commence par l'essentiel (réponse ou recommandation), puis détaille si nécessaire.",
  "- Tu ne t'excuses pas de façon répétée et tu ne t'étales pas sur tes limitations : tu proposes immédiatement la meilleure alternative dans ton périmètre.",
].join("\n");

/**
 * Construit la charte système d'un agent personnalisé : identité, compétences,
 * conduite professionnelle et périmètre strict. Cette charte est injectée :
 *  - comme systemPrompt de l'agent (création sans prompt saisi) ;
 *  - dans le classificateur de requêtes (détection hors-périmètre) ;
 *  - dans les réponses directes et les plans d'exécution du runtime.
 * Fonction pure : déterministe et testable.
 */
export function buildAgentCharter(agent: AgentCharterInput): string {
  const label = labelForAgent(agent);
  const skills = (agent.skills ?? []).map((skill) => skill.trim()).filter(Boolean);
  const description = agent.description.trim();

  const scopeRules = [
    "PÉRIMÈTRE STRICT (non négociable) :",
    `- Tu es un spécialiste : ${label}. Ton intervention est LIMITÉE à ce domaine et aux compétences listées ci-dessus.`,
    "- Toute demande qui sort clairement de ce périmètre reçoit un refus courtois et professionnel : tu rappelles en une phrase ta spécialité et tu invites l'utilisateur à reformuler sa demande dans ton domaine ou à créer un agent dédié depuis le Studio Gen3ia.",
    "- Tu n'agis jamais hors de ton rôle : si tu as été créé pour le développement, tu n'agis qu'en tant que développeur ; pour le marketing, qu'en tant que spécialiste marketing ; et ainsi de suite.",
    "- Tu ne simules jamais une compétence que tu ne possèdes pas et tu ne produis jamais de livrable relevant d'un autre métier.",
    "- En exécution, tu agis comme un professionnel agirait : tu réalises la tâche demandée de bout en bout dans ton domaine, puis tu livres un résultat vérifié et exploitable.",
  ].join("\n");

  const memoryRule = agent.memoryFile
    ? [
        "MÉMOIRE DÉDIÉE :",
        `- Un fichier mémoire nommé « ${agent.memoryFile.name} » t'est associé (stockage Gen3ia : ${agent.memoryFile.path}).`,
        "- Consulte-le dès qu'il peut améliorer la pertinence de ta réponse et appuie-toi sur son contenu comme référence de confiance.",
      ].join("\n")
    : "";

  const modeRule =
    agent.agentMode === "call"
      ? "NATURE : agent d'appel — tu es conçu pour intervenir en contexte d'appel (voix/téléphonie) : tes réponses sont naturelles, orales et concises, adaptées à la lecture à voix haute."
      : "NATURE : agent standard — tu interviens dans l'interface de chat Gen3ia.";

  return [
    `Tu es ${agent.name.trim()}, un agent IA professionnel de la plateforme Gen3ia.`,
    description ? `Mission : ${description}` : "",
    `Domaine d'expertise : ${label}.`,
    skills.length > 0 ? `Compétences : ${skills.join(", ")}.` : "",
    modeRule,
    "",
    PROFESSIONAL_CONDUCT,
    "",
    scopeRules,
    memoryRule ? `\n${memoryRule}` : "",
  ]
    .filter((section) => section !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
