/**
 * NavRegistry — source unique de vérité pour toute la navigation Gen3ia.
 *
 * Architecture à 3 espaces :
 *  - "workspace" : l'espace utilisateur — IA-FIRST : le Chat IA est le centre,
 *    le Cerveau (moteur neural) et l'Entraînement en sont les instruments ;
 *  - "developer" : l'espace développeur (projets, build, connecteurs, API, extensions, monitoring)
 *  - "admin"     : l'espace opérateur (vue plateforme, utilisateurs, modération, sécurité)
 *
 * Toutes les surfaces (AppShell, DeveloperShell, AdminShell, palette de
 * commandes, fil d'Ariane) consomment ce registre typé au lieu de maintenir
 * des tableaux séparés par page.
 *
 * Note (restructuration des parcours — demande propriétaire) : les
 * destinations majeures sont RÉTABLIES et hiérarchisées. Le dashboard
 * (chat IA) reste le point d'entrée central, mais chaque fonctionnalité
 * présentée sur la page d'accueil conduit désormais à un espace adapté :
 *  - « Entraînement de modèles » → /lab (Laboratoire de modèles : UI du
 *    AI Training Studio — projets, datasets, plans, jobs, modèles, exports) ;
 *  - « Gestion des datasets » → /data (Centre de données) ;
 *  - « Création d'agents » + tâches planifiées → /automations (Espace
 *    Automatisations unifié : agents + planifications — l'ancienne surface
 *    /planifications y est fusionnée et redirige vers #planifications) ;
 *  - « Connecteurs » → /integrations (Centre des intégrations) ;
 *  - « Stockage » → /storage (Bibliothèque de fichiers et d'artefacts) ;
 *  - « API et SDK » → /developer/api (Espace Développeurs).
 * RESTAURATION CONNEXE (propriétaire) : « Cerveau IA » (/neural, studio
 * d'entraînement) est réouvert à tous les comptes (voir user-access.ts) —
 * l'entrée perd son minRole admin.
 * Les surfaces expérimentales (Ondes, Arène, Monde, Essaim) restent
 * réservées admin.
 */

export type NavContext = "workspace" | "developer" | "admin";
/** Rôle minimal requis pour voir l'entrée. "user" = tout utilisateur connecté. */
export type NavRole = "user" | "developer" | "admin";

export interface NavRoute {
  /** Identifiant stable (utilisé comme clé React et cible de tests). */
  id: string;
  href: string;
  label: string;
  icon: string;
  /** Description courte affichée dans la palette de commandes. */
  description?: string;
  /** Espaces dans lesquels l'entrée est visible. */
  contexts: NavContext[];
  /** Rôle minimal requis (défaut : "user"). */
  minRole?: NavRole;
  /** Section d'affichage dans le shell correspondant. */
  section: "primary" | "secondary";
  /** Mots-clés supplémentaires pour la recherche de la palette. */
  keywords?: string[];
}

const WORKSPACE_PRIMARY: NavRoute[] = [
  {
    id: "chat-ia",
    href: "/dashboard",
    label: "Chat IA",
    icon: "✦",
    description: "Le dashboard EST le chat IA — prompt, fichiers, outils, effort, recherche web",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["chat", "ia", "intelligence", "conversation", "parler", "assistant", "dashboard", "nova"],
  },
  {
    // RESTRUCTURATION DES PARCOURS (demande propriétaire) : chaque
    // fonctionnalité présentée sur la page d'accueil conduit désormais à
    // un espace réellement adapté. « Entraînement de modèles » →
    // Laboratoire de modèles (l'UI du AI Training Studio décrite par les
    // API /api/training — restauration CRITIQUE du diagnostic).
    id: "lab",
    href: "/lab",
    label: "Laboratoire",
    icon: "⚗",
    description: "Laboratoire de modèles : entraînement, évaluation, modèles et exports",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["lab", "laboratoire", "entraînement", "entrainement", "training", "studio", "modèle", "modèles", "évaluation", "evaluation", "précision", "export", "dataset", "fine-tuning", "lora"],
  },
  {
    id: "data",
    href: "/data",
    label: "Données",
    icon: "▤",
    description: "Centre de données : datasets, import fichier et hubs HF/Kaggle, validation",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["données", "donnees", "dataset", "datasets", "centre", "import", "huggingface", "kaggle", "csv", "jsonl", "corpus"],
  },
  {
    id: "automations",
    href: "/automations",
    label: "Automatisations",
    icon: "◷",
    description: "Création d'agents et tâches planifiées récurrentes — l'espace des automatisations",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["automatisation", "automatisations", "agent", "agents", "planification", "planifiée", "cron", "récurrent", "veille", "tâche", "tâches", "schedule"],
  },
  {
    id: "ondes",
    href: "/ondes",
    label: "Ondes W-DNN",
    icon: "≋",
    description: "Laboratoire d'inférence par ondes — GPU, essaim P2P, écriture progressive",
    contexts: ["workspace"],
    section: "primary",
    // RÉSERVÉ ADMIN (demande : « les fonctionnalités que les utilisateurs
    // n'ont pas accès, faites qu'ils ne les voient pas ») — la page reste
    // en démo publique pour les anonymes mais est masquée + 403 pour un
    // compte standard (middleware deny-by-default).
    minRole: "admin",
    keywords: ["ondes", "wdnn", "wave", "gpu", "webgpu", "webrtc", "essaim", "p2p", "résonance", "kuramoto", "oscillateurs"],
  },
  {
    id: "arene",
    href: "/arene",
    label: "Arène d'interférence",
    icon: "⚛",
    description: "Les IA s'entraînent mutuellement par collision d'ondes — résonance et distillation physique",
    contexts: ["workspace"],
    section: "primary",
    minRole: "admin", // réserver admin — voir demande masquage
    keywords: ["arène", "arene", "interférence", "duel", "professeur", "élève", "distillation", "résonance", "ondes", "entraînement", "codec"],
  },
  {
    id: "monde",
    href: "/monde",
    label: "Le Monde",
    icon: "⌬",
    description: "Simulateur universel des lois de la nature — physique, quantique, relativité, équations",
    contexts: ["workspace"],
    section: "primary",
    minRole: "admin", // réserver admin — voir demande masquage
    keywords: ["monde", "simulation", "physique", "nature", "équations", "quantique", "relativité", "thermodynamique", "fluides", "mécanique", "ondes", "solveur", "science"],
  },
  {
    id: "essaim",
    href: "/essaim",
    label: "Essaim d'agents",
    icon: "⁂",
    description: "Agents décentralisés connectés à Gen3 : RAG privé chiffré, compétences injectées par ondes, auto-réparation, voix",
    contexts: ["workspace"],
    section: "primary",
    minRole: "admin", // réserver admin — voir demande masquage
    keywords: ["essaim", "agents", "décentralisé", "p2p", "webrtc", "rag", "chiffré", "compétences", "résilience", "voix", "vocal", "swarm"],
  },
  {
    id: "cerveau",
    href: "/neural",
    label: "Cerveau IA",
    icon: "◉",
    description: "Studio d'entraînement IA : constellation synaptique, conversation, médias et apprentissage",
    contexts: ["workspace"],
    section: "primary",
    // OUVERT À TOUS (demande propriétaire 10-2026 : « le studio d'entraînement
    // d'IA doit être accessible aux utilisateurs ») — les actions à privilège
    // (lancement d'entraînement global, reset) restent gardées côté routes
    // (requireAdmin) et masquées dans la console pour un compte standard.
    keywords: ["cerveau", "neural", "neurones", "snn", "réseau", "santé", "moteur", "ia", "entraînement", "studio"],
  },
];

const WORKSPACE_SECONDARY: NavRoute[] = [
  { id: "training-studio", href: "/training", label: "Studio d'entraînement", icon: "🎓", description: "Datasets, plans IA, tâches GPU réelles, rapports par époque et lineage", contexts: ["workspace"], section: "secondary", keywords: ["entraînement", "training", "studio", "dataset", "gpu", "modèle", "fine-tuning", "lora"] },
  { id: "team", href: "/team", label: "Équipe", icon: "◎", description: "Membres, rôles et activité partagée", contexts: ["workspace"], section: "secondary", keywords: ["équipe", "membres", "rôles"] },
  // RESTRUCTURATION DES PARCOURS : « Connecteurs » → Centre des
  // intégrations ; « Stockage » → Bibliothèque de fichiers et d'artefacts.
  // (L'ancienne entrée « Planifications » /planifications est FONDUE dans
  // l'Espace Automatisations /automations — onglet Planifications.)
  { id: "integrations", href: "/integrations", label: "Intégrations", icon: "⇄", description: "Connecteurs, messageries et webhooks de vos agents", contexts: ["workspace"], section: "secondary", keywords: ["intégrations", "connecteurs", "composio", "whatsapp", "telegram", "slack", "webhook", "oauth"] },
  { id: "storage", href: "/storage", label: "Bibliothèque", icon: "▣", description: "Bibliothèque de fichiers et d'artefacts — stockage permanent", contexts: ["workspace"], section: "secondary", keywords: ["bibliothèque", "fichiers", "stockage", "artefacts", "storage", "quota"] },
  { id: "live", href: "/live", label: "Agent Live", icon: "◉", description: "Contrôler un poste de travail", contexts: ["workspace"], section: "secondary", keywords: ["live", "pc"] },
  { id: "memory", href: "/memory", label: "Mémoire permanente", icon: "◆", description: "Souvenirs et connaissances des agents", contexts: ["workspace"], section: "secondary", keywords: ["mémoire", "knowledge"] },
  { id: "billing", href: "/billing", label: "Facturation", icon: "₣", description: "Abonnements et consommation", contexts: ["workspace"], section: "secondary", keywords: ["facturation", "abonnement"] },
  { id: "settings", href: "/settings", label: "Paramètres", icon: "⚙", description: "Compte, sécurité, numéros et préférences", contexts: ["workspace"], section: "secondary", keywords: ["paramètres", "compte"] },
];

const DEVELOPER_NAV: NavRoute[] = [
  {
    id: "dev-overview",
    href: "/developer",
    label: "Vue d'ensemble",
    icon: "⌂",
    description: "Activité, ressources et raccourcis du Developer Studio",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["développeur", "overview"],
  },
  {
    id: "dev-projects",
    href: "/developer/projects",
    label: "Projets",
    icon: "▦",
    description: "Créer et sélectionner les applications isolées",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["projets", "applications"],
  },
  {
    id: "dev-build",
    href: "/developer/build",
    label: "Build",
    icon: "＋",
    description: "Extension / Tool Builder déclaratif",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["build", "outils", "tools", "manifest"],
  },
  {
    id: "dev-connectors",
    href: "/developer/connectors",
    label: "Connecteurs",
    icon: "◎",
    description: "Catalogue Composio et connexions du projet",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["connecteurs", "composio", "oauth"],
  },
  {
    id: "dev-api",
    href: "/developer/api",
    label: "API & SDK",
    icon: "⚿",
    description: "Clés liées à un projet et contrat SDK",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["api", "sdk", "clés"],
  },
  {
    id: "dev-extensions",
    href: "/developer/extensions",
    label: "Extensions",
    icon: "◇",
    description: "Versions, permissions, installations et exécutions",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["extensions", "versions", "permissions"],
  },
  {
    id: "dev-payouts",
    href: "/developer/payouts",
    label: "Revenus & retraits",
    icon: "₣",
    description: "Revenus nets, demandes de retrait et historique des mandats",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["revenus", "retraits", "payouts", "paiement", "facturation développeur"],
  },
  {
    id: "dev-monitoring",
    href: "/developer/monitoring",
    label: "Monitoring",
    icon: "∿",
    description: "Exécutions, installations et revenus",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["monitoring", "revenus", "statistiques"],
  },
];

const ADMIN_NAV: NavRoute[] = [
  {
    id: "admin-platform",
    href: "/admin",
    label: "Vue plateforme",
    icon: "⌂",
    description: "Indicateurs globaux : utilisateurs, missions, extensions",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["plateforme", "statistiques", "admin"],
  },
  {
    id: "admin-users",
    href: "/admin/users",
    label: "Utilisateurs et équipes",
    icon: "◎",
    description: "Comptes, rôles et équipes de la plateforme",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["utilisateurs", "équipes", "comptes"],
  },
  {
    id: "admin-extensions",
    href: "/admin/extensions",
    label: "Extensions à revoir",
    icon: "◇",
    description: "File de modération des versions soumises",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["extensions", "modération", "revue"],
  },
  {
    id: "admin-payouts",
    href: "/admin/payouts",
    label: "Retraits développeurs",
    icon: "₣",
    description: "Mandats de paiement à traiter (approuver, rejeter, marquer payés)",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["retraits", "payouts", "paiements", "développeurs", "mandats"],
  },
  {
    id: "admin-ads",
    href: "/admin/ads",
    label: "Inventaire publicitaire",
    icon: "▶",
    description: "Emplacements publicitaires de la plateforme",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["publicité", "ads", "inventaire"],
  },
  {
    id: "admin-security",
    href: "/admin/security",
    label: "Sécurité et audit",
    icon: "⚖",
    description: "Journal d'audit des outils et accès sensibles",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["sécurité", "audit", "journal"],
  },
  {
    id: "admin-observability",
    href: "/admin/observability",
    label: "Observabilité",
    icon: "∿",
    description: "Exécutions, coûts et santé de la plateforme",
    contexts: ["admin"],
    minRole: "admin",
    section: "primary",
    keywords: ["observabilité", "exécutions", "coûts"],
  },
];

/** Registre complet, ordonné (l'ordre d'affichage suit l'ordre du tableau). */
export const NAV_REGISTRY: readonly NavRoute[] = [
  ...WORKSPACE_PRIMARY,
  ...WORKSPACE_SECONDARY,
  ...DEVELOPER_NAV,
  ...ADMIN_NAV,
];

/** Entrées visibles pour un espace et un rôle donnés. */
export function navFor(context: NavContext, role: NavRole = "user"): NavRoute[] {
  return NAV_REGISTRY.filter(
    (route) =>
      route.contexts.includes(context) &&
      (!route.minRole || minRoleSatisfied(role, route.minRole)),
  );
}

export function navPrimaryFor(context: NavContext, role: NavRole = "user"): NavRoute[] {
  return navFor(context, role).filter((route) => route.section === "primary");
}

export function navSecondaryFor(context: NavContext, role: NavRole = "user"): NavRoute[] {
  return navFor(context, role).filter((route) => route.section === "secondary");
}

const ROLE_ORDER: Record<NavRole, number> = { user: 0, developer: 1, admin: 2 };

export function minRoleSatisfied(role: NavRole, minRole: NavRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[minRole];
}

/** Recherche une route exacte (ou par préfixe de segment) pour le fil d'Ariane. */
export function matchNavRoute(pathname: string): NavRoute | undefined {
  if (pathname === "/") return undefined;
  return (
    NAV_REGISTRY.find((route) => route.href === pathname) ??
    NAV_REGISTRY.filter((route) => route.href !== "/")
      .sort((a, b) => b.href.length - a.href.length)
      .find((route) => pathname.startsWith(route.href + "/"))
  );
}

/** Index plat pour la palette de commandes (⌘K), filtré par rôle. */
export function navCommandIndex(role: NavRole): Array<NavRoute & { group: string }> {
  const groupTitles: Record<NavContext, string> = {
    workspace: "Espace de travail",
    developer: "Développeur",
    admin: "Administration",
  };
  return navFor("workspace", role)
    .map((route) => ({ ...route, group: groupTitles.workspace }))
    .concat(
      navFor("developer", role).map((route) => ({ ...route, group: groupTitles.developer })),
    )
    .concat(navFor("admin", role).map((route) => ({ ...route, group: groupTitles.admin })));
}
