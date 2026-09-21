export type NavItem = {
  href: string;
  label: string;
  icon: string;
  shortcut?: string;
  hint?: string;
  requiredRole?: "developer";
};

export const WORKSPACE: NavItem[] = [
  { href: "/dashboard", label: "Accueil", icon: "⌂", shortcut: "H" },
  { href: "/studio", label: "Agent", icon: "✦", shortcut: "A" },
  { href: "/live", label: "Live", icon: "◉" },
  { href: "/marketplace", label: "Marketplace", icon: "◇" },
];

export const AGENTS: NavItem[] = [
  { href: "/studio/schedules", label: "Tâches planifiées", icon: "◷" },
  { href: "/observability", label: "Observabilité", icon: "∿", hint: "Traces, coûts et alertes de vos agents" },
  { href: "/integrations", label: "Intégrations", icon: "⧉", hint: "Connecter vos services externes" },
];

export const LIBRARY: NavItem[] = [
  { href: "/memory", label: "Mémoire permanente", icon: "◆" },
  { href: "/storage", label: "Fichiers", icon: "□" },
  { href: "/marketplace/purchases", label: "Mes achats", icon: "◈" },
  { href: "/team", label: "Équipe", icon: "◎" },
  { href: "/billing", label: "Facturation", icon: "₣" },
];

export const DEVELOPER: NavItem[] = [
  { href: "/developer", label: "Developer Studio", icon: "⌥", hint: "API, SDK, extensions et connecteurs", requiredRole: "developer" },
];

export const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  { title: "Espace de travail", items: WORKSPACE },
  { title: "Agents & automatisation", items: AGENTS },
  { title: "Ressources", items: LIBRARY },
  { title: "Développeur", items: DEVELOPER },
];

/** Index plat consommé par la palette de navigation (⌘K). */
export const NAV_COMMAND_INDEX: Array<NavItem & { group: string }> = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.title })),
);
