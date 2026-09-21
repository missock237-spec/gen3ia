export type NavItem = {
  href: string;
  label: string;
  icon: string;
  shortcut?: string;
  hint?: string;
};

export const WORKSPACE: NavItem[] = [
  { href: "/dashboard", label: "Accueil", icon: "⌂", shortcut: "H" },
  { href: "/studio", label: "Agent", icon: "✦", shortcut: "A" },
  { href: "/live", label: "Live", icon: "◉" },
  { href: "/marketplace", label: "Marketplace", icon: "◇" },
];

export const TOOLS: NavItem[] = [
  { href: "/studio/interface-lab", label: "Atelier d'Interfaces", icon: "⌘", hint: "Réservé aux agents de code" },
  { href: "/studio/schedules", label: "Tâches planifiées", icon: "◷" },
  { href: "/observability", label: "Observabilité", icon: "∿", hint: "Traces, coûts et alertes des agents" },
  { href: "/integrations", label: "Intégrations", icon: "⧉", hint: "WhatsApp, Telegram, LinkedIn, Stripe…" },
  { href: "/features", label: "Fonctionnalités cachées", icon: "✧", hint: "Portail client, API, webhooks, voix…" },
];

export const LIBRARY: NavItem[] = [
  { href: "/memory", label: "Mémoire permanente", icon: "◆" },
  { href: "/storage", label: "Fichiers", icon: "□" },
  { href: "/marketplace/purchases", label: "Mes achats", icon: "◈" },
  { href: "/team", label: "Équipe", icon: "◎" },
];

export const PLATFORM: NavItem[] = [
  { href: "/developer", label: "Développeur", icon: "⌥" },
  { href: "/billing", label: "Facturation", icon: "₣" },
];

export const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  { title: "Espace de travail", items: WORKSPACE },
  { title: "Outils", items: TOOLS },
  { title: "Bibliothèque", items: LIBRARY },
  { title: "Plateforme", items: PLATFORM },
];

/** Index plat consommé par la palette de navigation (⌘K). */
export const NAV_COMMAND_INDEX: Array<NavItem & { group: string }> = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.title })),
);
