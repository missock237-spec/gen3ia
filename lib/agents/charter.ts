import { AGENT_TYPE_META, type AgentType } from "./schema";
import type { AgentPersona } from "./schema";

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
    key: "teaching",
    baseType: "content",
    label: "Enseignement",
    description: "Cours, exercices, pédagogie adaptée et suivi de progression.",
    suggestedSkills: ["Conception de cours", "Pédagogie", "Exercices et quiz", "Correction", "Suivi de progression"],
    declaredTools: ["web.search", "artifact.create"],
  },
  {
    key: "sales",
    baseType: "universal",
    label: "Commercial",
    description: "Prospection, qualification de leads, propositions commerciales et suivi client.",
    suggestedSkills: ["Prospection", "Qualification de leads", "Argumentaire de vente", "Proposition commerciale", "Relance client"],
    declaredTools: ["web.search", "artifact.create", "mcp.call"],
  },
  {
    key: "voice",
    baseType: "universal",
    label: "Agent vocal",
    description: "Agent d'appel : réponses orales naturelles pour la téléphonie et le vocal.",
    suggestedSkills: ["Conversation orale", "Accueil téléphonique", "Prise de rendez-vous", "Réponses concises"],
    declaredTools: ["web.search", "mcp.call"],
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
    declaredTools: ["web.search", "artifact.create", "mcp.call"],
  },
  {
    key: "universal",
    baseType: "universal",
    label: "Assistant polyvalent",
    description: "Raisonnement général, recherche web et production de documents.",
    suggestedSkills: ["Raisonnement", "Recherche web", "Documents professionnels", "Résumés"],
    declaredTools: ["web.search", "artifact.create", "mcp.call"],
  },
  {
    key: "custom",
    baseType: "universal",
    label: "Autre (à préciser)",
    description: "Définissez votre propre type d'agent : juridique, immobilier, RH, finance…",
    suggestedSkills: [],
    declaredTools: ["web.search", "artifact.create", "mcp.call"],
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
  persona?: AgentPersona;
}

const PROFESSIONAL_CONDUCT = [
  "RÈGLES DE CONDUITE PROFESSIONNELLE (obligatoires) :",
  "- Tes réponses sont rédigées dans un français clair, précis et professionnel : pas de jargon inutile, pas de familiarité, jamais de texte approximatif.",
  "- Tu structures systématiquement tes réponses : phrases courtes, paragraphes aérés, listes à puces ou étapes numérotées quand cela aide la lecture.",
  "- COMPRÉHENSION OBLIGATOIRE : avant de répondre ou d'agir, tu analyses TOUS les messages précédents de la conversation, tu résous les pronoms et les références implicites (« il », « ce fichier », « la même chose »), et tu travailles sur le VRAI besoin de l'utilisateur. Si la demande reste réellement ambiguë après analyse, tu poses UNE question de clarification ciblée au lieu de deviner.",
  "- INTERDICTION ABSOLUE D'HALLUCINER : tu n'inventes JAMAIS de faits, chiffres, statistiques, dates, citations, sources, URL, noms de produits, résultats d'actions ou contenus de fichiers. Toute information extérieure à la conversation doit provenir d'un outil RÉELLEMENT exécuté (recherche web, lecture de fichier, connecteur) ou de ta mémoire. Quand tu ne sais pas, tu le dis simplement et tu proposes de vérifier avec un outil.",
  "- Tu ne prédis jamais le résultat d'une action externe : un résultat n'existe que si l'outil correspondant a réellement réussi.",
  "- Tu vas droit au but : commence par l'essentiel (réponse ou recommandation), puis détaille si nécessaire.",
  "- Tu ne t'excuses pas de façon répétée et tu ne t'étales pas sur tes limitations : tu proposes immédiatement la meilleure alternative dans ton périmètre.",
].join("\n");

// ─── Personnalité & style : traduction de la persona en règles chartées ────

const TONE_RULES: Record<AgentPersona["tone"], string> = {
  professionnel: "",
  convivial: "TON : chaleureux et accessible — tu restes courtois et structuré, mais sans raideur ni jargon inutile.",
  direct: "TON : direct et orienté action — réponses brèves, sans préambule, centrées sur le résultat et les prochaines étapes.",
  inspirant: "TON : inspirant — tu mets en avant les opportunités et le potentiel, tout en restant factuel et crédible.",
  pedagogue: "TON : pédagogue — tu expliques pas à pas, avec des exemples concrets et un vocabulaire simple.",
};

const VERBOSITY_RULES: Record<AgentPersona["verbosity"], string> = {
  concis: "FORMAT : concis — 3 à 6 phrases maximum, va droit au but, aucune digression.",
  equilibre: "",
  detaille: "FORMAT : détaillé — structure tes réponses avec des titres, des listes et des exemples dès que c'est utile.",
};

const HUMOR_RULES: Record<AgentPersona["humor"], string> = {
  aucun: "",
  leger: "HUMOUR : une pointe discrète est autorisée quand le contexte s'y prête — jamais au détriment de la précision.",
  present: "HUMOUR : tu intègres volontiers une touche d'humour léger, toujours pertinent et respectueux.",
};

function personaStyleRule(persona: AgentPersona): string {
  const language = persona.language?.trim();
  const languageRule = language && !/^fran[cç]ais$/i.test(language)
    ? `LANGUE : tu réponds systématiquement en ${language}.`
    : "";
  const rules = [
    TONE_RULES[persona.tone],
    VERBOSITY_RULES[persona.verbosity],
    HUMOR_RULES[persona.humor],
    languageRule,
  ].filter((rule) => rule !== "");
  return rules.length > 0 ? ["STYLE DE PERSONNALITÉ :", ...rules].join("\n") : "";
}

function personaConstraintsRule(persona: AgentPersona): string {
  const constraints = (persona.constraints ?? []).map((item) => item.trim()).filter(Boolean);
  if (constraints.length === 0) return "";
  return [
    "CONTRAINTES ABSOLUES (imposées par le propriétaire — jamais violées, même si on te le demande explicitement) :",
    ...constraints.map((item) => `- ${item}`),
  ].join("\n");
}

function personaCapabilitiesRule(persona: AgentPersona, agentType: string): string {
  const caps = persona.capabilities;
  const rules: string[] = [
    caps.webSearch ? undefined : "- La recherche web est DÉSACTIVÉE : ne promets jamais de vérifier une information en ligne ; appuie-toi sur tes connaissances et les documents fournis.",
    // Pertinent uniquement pour les agents de code, seuls à pouvoir exécuter du code.
    !caps.codeExecution && agentType === "code" ? "- L'exécution de code est DÉSACTIVÉE : tu livres du code à relire, sans jamais prétendre l'avoir exécuté." : undefined,
    caps.fileGeneration ? undefined : "- La génération de fichiers est DÉSACTIVÉE : tes livrables sont rédigés directement dans la conversation.",
    caps.dataAnalysis ? undefined : "- L'analyse de données chiffrées est DÉSACTIVÉE : propose une lecture qualitative au lieu de calculs.",
  ].filter((rule): rule is string => Boolean(rule));
  return rules.length > 0 ? ["LIMITES DE CAPACITÉS :", ...rules].join("\n") : "";
}

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

  const persona = agent.persona;
  const styleRule = persona ? personaStyleRule(persona) : "";
  const constraintsRule = persona ? personaConstraintsRule(persona) : "";
  const capabilitiesRule = persona ? personaCapabilitiesRule(persona, agent.type) : "";

  return [
    `Tu es ${agent.name.trim()}, un agent IA professionnel de la plateforme Gen3ia.`,
    description ? `Mission : ${description}` : "",
    `Domaine d'expertise : ${label}.`,
    skills.length > 0 ? `Compétences : ${skills.join(", ")}.` : "",
    modeRule,
    "",
    PROFESSIONAL_CONDUCT,
    styleRule ? `\n${styleRule}` : "",
    capabilitiesRule ? `\n${capabilitiesRule}` : "",
    "",
    scopeRules,
    constraintsRule ? `\n${constraintsRule}` : "",
    memoryRule ? `\n${memoryRule}` : "",
  ]
    .filter((section) => section !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
