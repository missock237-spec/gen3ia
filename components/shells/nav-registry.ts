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
 * Note (suppression surfaces workspace/studio) : les anciennes entrées
 * « Conversations » (/workspace), « Entraînement IA », « Bases de
 * connaissances », « Projets », « Fichiers », « Automatisations » (/studio),
 * « Planifications », « Connecteurs », « Bibliothèque » et « Workshop IDE »
 * (/studio/console) ont été retirées avec leurs surfaces — le dashboard
 * (chat IA) est le point d'entrée unique.
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
    description: "Le moteur neural Gen3 en direct : santé, cycles, état du réseau",
    contexts: ["workspace"],
    section: "primary",
    minRole: "admin", // réserver admin — voir demande masquage
    keywords: ["cerveau", "neural", "neurones", "snn", "réseau", "santé", "moteur", "ia"],
  },
];

const WORKSPACE_SECONDARY: NavRoute[] = [
  { id: "team", href: "/team", label: "Équipe", icon: "◎", description: "Membres, rôles et activité partagée", contexts: ["workspace"], section: "secondary", keywords: ["équipe", "membres", "rôles"] },
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
