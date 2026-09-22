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

/** Modules métier (Task 15) — construits sur les 6 moteurs communs. */
export const BUSINESS: NavItem[] = [
  { href: "/studio/marketing/landing", label: "Marketing", icon: "▶", hint: "Landing Pages et Webinar → Contenus" },
  { href: "/studio/sales/call-intelligence", label: "Ventes", icon: "☎", hint: "Call Intelligence : analyse de vos appels" },
  { href: "/studio/hr/leaves", label: "RH", icon: "☺", hint: "Congés et formations" },
  { href: "/studio/documents/contracts", label: "Documents", icon: "▤", hint: "Contrats et onboarding" },
  { href: "/studio/compliance/gdpr", label: "Conformité", icon: "⚖", hint: "RGPD : registre et demandes" },
  { href: "/studio/operations/maintenance", label: "Opérations", icon: "⚒", hint: "Maintenance préventive" },
  { href: "/studio/finance/cashflow", label: "Finance", icon: "₣", hint: "Cashflow et impayés" },
  { href: "/studio/automations", label: "Automatisations", icon: "⚡", hint: "Workflows événementiels entre modules" },
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
  { title: "Modules métier", items: BUSINESS },
  { title: "Ressources", items: LIBRARY },
  { title: "Développeur", items: DEVELOPER },
];

/** Index plat consommé par la palette de navigation (⌘K). */
export const NAV_COMMAND_INDEX: Array<NavItem & { group: string }> = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.title })),
);
