/**
 * NavRegistry — source unique de vérité pour toute la navigation Gen3ia.
 *
 * Architecture à 3 espaces :
 *  - "workspace" : l'espace utilisateur (Missions, Créer, Résultats, Connexions, Équipe)
 *  - "developer" : l'espace développeur (projets, build, connecteurs, API, extensions, monitoring)
 *  - "admin"     : l'espace opérateur (vue plateforme, utilisateurs, modération, sécurité)
 *
 * Toutes les surfaces (WorkspaceShell, DeveloperShell, AdminShell, palette de
 * commandes, fil d'Ariane) consomment ce registre typé au lieu de maintenir
 * des tableaux séparés par page.
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
    id: "conversations",
    href: "/workspace",
    label: "Conversations",
    icon: "✦",
    description: "Conversations persistantes avec exécution d'agents",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["conversations", "chat", "agent", "messages"],
  },
  {
    id: "projects",
    href: "/workspace/projects",
    label: "Projets",
    icon: "▦",
    description: "Contextes persistants : instructions, fichiers, connecteurs",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["projets", "instructions", "contexte"],
  },
  {
    id: "files",
    href: "/workspace/files",
    label: "Fichiers",
    icon: "□",
    description: "Stockage permanent et livrables générés",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["fichiers", "livrables", "stockage", "artefacts", "résultats"],
  },
  {
    id: "connectors",
    href: "/workspace/connectors",
    label: "Connecteurs",
    icon: "⧉",
    description: "Applications connectées, état vérifié et permissions",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["connecteurs", "intégrations", "composio", "applications", "connexions"],
  },
  {
    id: "library",
    href: "/workspace/bibliotheque",
    label: "Bibliothèque",
    icon: "◈",
    description: "Capacités métier, modèles de prompts et agents spécialisés",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["bibliothèque", "modèles", "capacités", "marketing", "sales", "rh", "finance", "missions", "créer"],
  },
  {
    id: "knowledge",
    href: "/workspace/knowledge",
    label: "Knowledge",
    icon: "▤",
    description: "Bases de connaissances RAG : documents, pages web, recherche",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["knowledge", "connaissances", "documents", "rag", "recherche", "embeddings", "wiki"],
  },
  {
    id: "workflows",
    href: "/workspace/workflows",
    label: "Workflows",
    icon: "⎇",
    description: "Graphes d'automatisation exécutables : agents, outils, conditions",
    contexts: ["workspace"],
    section: "primary",
    keywords: ["workflow", "automatisation", "graphe", "nœuds", "scénarios", "workflows"],
  },
];

const WORKSPACE_SECONDARY: NavRoute[] = [
  { id: "missions", href: "/studio", label: "Missions", icon: "◈", description: "Tâches en cours, validations et historique", contexts: ["workspace"], section: "secondary", keywords: ["missions", "tâches", "historique"] },
  { id: "team", href: "/team", label: "Équipe", icon: "◎", description: "Membres, rôles et activité partagée", contexts: ["workspace"], section: "secondary", keywords: ["équipe", "membres", "rôles"] },
  { id: "live", href: "/live", label: "Agent Live", icon: "◉", description: "Contrôler un poste de travail", contexts: ["workspace"], section: "secondary", keywords: ["live", "pc"] },
  { id: "marketplace", href: "/marketplace", label: "Marketplace", icon: "◇", description: "Ajouter des capacités à vos agents", contexts: ["workspace"], section: "secondary", keywords: ["marketplace", "extensions"] },
  { id: "schedules", href: "/studio/schedules", label: "Tâches planifiées", icon: "◷", description: "Exécutions récurrentes de vos agents", contexts: ["workspace"], section: "secondary", keywords: ["planifiées", "cron"] },
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
  {
    id: "dev-ide",
    href: "/studio/console",
    label: "Workshop IDE",
    icon: "❯_",
    description: "Workspace IDE unifié : terminal agent, éditeur, logs, aperçu, tests",
    contexts: ["developer"],
    minRole: "developer",
    section: "primary",
    keywords: ["ide", "terminal", "éditeur", "code", "workshop", "console"],
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
