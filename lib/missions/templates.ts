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

/** Catégories distinctes, dans l'ordre d'affichage. */
export function templateCategories(): string[] {
  const seen: string[] = [];
  for (const template of MISSION_TEMPLATES) {
    if (!seen.includes(template.category)) seen.push(template.category);
  }
  return seen;
}
