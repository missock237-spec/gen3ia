/**
 * Modèles de missions — les modules métier (Task 15) deviennent des modèles
 * et filtres dans « Créer » au lieu de huit entrées permanentes de menu.
 * Chaque modèle pré-remplit l'objectif de la mission et indique les moteurs
 * communs mobilisés (ai, document, workflow, scheduling, analytics, data).
 */

export type EngineId = "ai" | "document" | "workflow" | "scheduling" | "analytics" | "data";

export interface MissionTemplate {
  id: string;
  label: string;
  icon: string;
  /** Une phrase qui décrit le résultat attendu. */
  description: string;
  /** Objectif pré-rempli dans le composer (éditable par l'utilisateur). */
  objectiveSample: string;
  /** Placeholder adapté au modèle. */
  placeholder: string;
  /** Moteurs communs mobilisés (affichage + routage futur). */
  engines: EngineId[];
  /** Filtre/catégorie affiché dans le composer. */
  category: string;
  /**
   * SYSTÈME MISSION AVANCÉ — critères d'acceptation professionnels du
   * modèle (contrat de résultat appliqué à la mission) : chaque critère
   * est vérifié par la porte de sortie du runtime (déterministe ou juge
   * LLM). Une mission sous modèle n'est « Terminée » que si son contrat
   * est satisfait — façon humain : on ne livre pas à moitié.
   */
  acceptance?: MissionAcceptance;
}

export interface MissionAcceptance {
  /** Format de livrable attendu (contrat artifact_format). */
  format?: string;
  /** Longueur minimale du livrable (contrat min_length). */
  minLength?: number;
  /** Motifs qui DOIVENT apparaître dans le livrable (contrat contains). */
  contains?: string[];
  /** Motifs INTERDITS dans le livrable (contrat not_contains). */
  notContains?: string[];
}

export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  {
    id: "free",
    label: "Libre",
    icon: "✦",
    description: "Décrivez n'importe quel objectif ; Gen3ia planifie les étapes.",
    objectiveSample: "",
    placeholder: "Ex. : prépare un point hebdo, analyse mes ventes et rédige le compte rendu…",
    engines: ["ai"],
    category: "Général",
  },
  {
    id: "marketing-landing",
    label: "Landing Page",
    icon: "▶",
    description: "Landing page prête à publier : accroche, bénéfices, preuve, CTA.",
    objectiveSample: "Crée une landing page pour ",
    placeholder: "Ex. : une landing page pour mon application de réservation pour salons de coiffure…",
    engines: ["ai", "document"],
    category: "Marketing",
    acceptance: {
      minLength: 4_000,
      contains: ["accroche", "bénéfice", "appel à l'action"],
      notContains: ["TODO", "Lorem ipsum"],
    },
  },
  {
    id: "marketing-webinar",
    label: "Webinar → Contenus",
    icon: "◉",
    description: "Transforme un webinaire en articles, posts et e-mails de suivi.",
    objectiveSample: "Transforme la transcription de mon webinaire en contenus : ",
    placeholder: "Ex. : 3 posts LinkedIn, un article de blog et un e-mail de remerciement…",
    engines: ["ai", "document", "workflow"],
    category: "Marketing",
  },
  {
    id: "sales-call-intelligence",
    label: "Call Intelligence",
    icon: "☎",
    description: "Analyse d'appels : résumé, objections, prochaines actions.",
    objectiveSample: "Analyse mon appel de vente et produis un compte rendu avec objections et prochaines actions : ",
    placeholder: "Ex. : analyse l'appel d'hier avec le prospect Acme…",
    engines: ["ai", "analytics"],
    category: "Ventes",
  },
  {
    id: "hr-leaves",
    label: "Congés",
    icon: "☺",
    description: "Demandes de congés, soldes et validations d'équipe.",
    objectiveSample: "Traite une demande de congé : ",
    placeholder: "Ex. : enregistre 5 jours ouvrés de congés pour Marc du 3 au 7 novembre…",
    engines: ["scheduling", "workflow"],
    category: "RH",
  },
  {
    id: "hr-training",
    label: "Formations",
    icon: "✎",
    description: "Parcours de formation et suivi de progression.",
    objectiveSample: "Construis un parcours de formation sur ",
    placeholder: "Ex. : un parcours onboarding sécurité en 3 modules pour les nouveaux arrivants…",
    engines: ["ai", "document", "scheduling"],
    category: "RH",
  },
  {
    id: "documents-contracts",
    label: "Contrat",
    icon: "▤",
    description: "Génération de contrats avec preuve et suivi de signature.",
    objectiveSample: "Rédige un contrat de ",
    placeholder: "Ex. : un contrat de prestation de 6 mois pour une mission de design…",
    engines: ["document", "workflow"],
    category: "Documents",
  },
  {
    id: "documents-onboarding",
    label: "Onboarding",
    icon: "☰",
    description: "Séquence d'accueil : documents, échéances et validations.",
    objectiveSample: "Prépare une séquence d'onboarding pour ",
    placeholder: "Ex. : l'arrivée d'un développeur senior la semaine prochaine…",
    engines: ["document", "scheduling", "workflow"],
    category: "Documents",
  },
  {
    id: "compliance-rgpd",
    label: "RGPD",
    icon: "⚖",
    description: "Registre, demandes d'accès et réponses de conformité.",
    objectiveSample: "Traite une demande RGPD de type ",
    placeholder: "Ex. : export de données pour client@example.com…",
    engines: ["document", "workflow"],
    category: "Conformité",
  },
  {
    id: "operations-maintenance",
    label: "Maintenance",
    icon: "⚒",
    description: "Plan de maintenance préventive et rappels d'échéances.",
    objectiveSample: "Établis un plan de maintenance préventive pour ",
    placeholder: "Ex. : mon parc de 12 machines à café avec un contrôle mensuel…",
    engines: ["scheduling", "analytics"],
    category: "Opérations",
  },
  {
    id: "finance-cashflow",
    label: "Cashflow",
    icon: "₣",
    description: "Prévision de trésorerie et scénarios à 90 jours.",
    objectiveSample: "Analyse ma trésorerie et produis une prévision à 90 jours à partir de ",
    placeholder: "Ex. : mes entrées/sorties du dernier trimestre…",
    engines: ["analytics", "document"],
    category: "Finance",
    acceptance: {
      minLength: 3_000,
      contains: ["90 jours", "scénario"],
      notContains: ["TODO"],
    },
  },
  {
    id: "finance-unpaid",
    label: "Impayés",
    icon: "⌗",
    description: "Relances graduées et suivi des factures en retard.",
    objectiveSample: "Traite mes factures impayées et prépare des relances graduées pour ",
    placeholder: "Ex. : les factures en retard de plus de 30 jours…",
    engines: ["analytics", "document", "workflow"],
    category: "Finance",
  },
  {
    id: "automation-flow",
    label: "Automatisation",
    icon: "⚡",
    description: "Workflow événementiel entre vos outils et modules.",
    objectiveSample: "Crée une automatisation : quand ",
    placeholder: "Ex. : quand une facture est émise, envoie une notification et programme la relance…",
    engines: ["workflow", "ai"],
    category: "Automatisations",
  },
];

export function templateById(id: string): MissionTemplate | undefined {
  return MISSION_TEMPLATES.find((template) => template.id === id);
}

/**
 * Construit le CONTRAT DE RÉSULTAT d'un modèle (système mission avancé).
 * Les critères sont déterministes quand possible (coût nul, reproductible) :
 * min_length, contains, not_contains, artifact_format. Retourne undefined
 * pour le modèle « libre » ou sans critères.
 */
export function contractForTemplate(templateId: string): MissionAcceptance | undefined {
  const template = templateById(templateId);
  if (!template?.acceptance) return undefined;
  return template.acceptance;
}

/**
 * Convertit des critères d'acceptation en CONTRAT DE RÉSULTAT exécutable
 * (schéma OutcomeContract du runtime). Import de TYPE uniquement : ce
 * module reste pur et partagé client/serveur.
 */
export function acceptanceToOutcomeContract(
  acceptance: MissionAcceptance,
): import("@/lib/agents/outcome-contract").OutcomeContract {
  const criteria: import("@/lib/agents/outcome-contract").OutcomeCriterion[] = [];
  if (acceptance.minLength) {
    criteria.push({
      id: "min_length",
      description: `Le livrable compte au moins ${acceptance.minLength} caractères.`,
      kind: "min_length",
      minLength: acceptance.minLength,
      required: true,
    });
  }
  (acceptance.contains ?? []).forEach((pattern, index) => {
    criteria.push({
      id: `contains_${index + 1}`,
      description: `Le livrable mentionne « ${pattern} ».`,
      kind: "contains",
      pattern,
      required: true,
    });
  });
  (acceptance.notContains ?? []).forEach((pattern, index) => {
    criteria.push({
      id: `not_contains_${index + 1}`,
      description: `Le livrable ne contient aucun « ${pattern} » (espace réservé ou texte de remplissage interdit).`,
      kind: "not_contains",
      pattern,
      required: true,
    });
  });
  if (acceptance.format) {
    criteria.push({
      id: "artifact_format",
      description: `Un livrable téléchargeable au format ${acceptance.format.toUpperCase()} est remis.`,
      kind: "artifact_format",
      format: acceptance.format,
      required: true,
    });
  }
  return { criteria, failPolicy: "retry_once" };
}

/** Catégories distinctes, dans l'ordre d'affichage. */
export function templateCategories(): string[] {
  const seen: string[] = [];
  for (const template of MISSION_TEMPLATES) {
    if (!seen.includes(template.category)) seen.push(template.category);
  }
  return seen;
}
