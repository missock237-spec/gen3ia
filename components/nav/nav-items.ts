/**
 * Adaptateur de navigation — dérive désormais du NavRegistry unique
 * (components/shells/nav-registry.ts) pour garantir une seule source de
 * vérité entre les 3 shells (workspace / developer / admin), le fil d'Ariane
 * et la palette de commandes.
 *
 * Architecture conversation-first : la navigation principale est
 * Conversations · Projets · Fichiers · Connecteurs · Bibliothèque ; les
 * modules métier sont des capacités (bibliothèque + conversations), pas
 * des entrées de menu permanentes.
 */
import { NAV_REGISTRY, navCommandIndex, type NavRoute } from "@/components/shells/nav-registry";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  shortcut?: string;
  hint?: string;
  requiredRole?: "developer" | "admin";
};

function toItem(route: NavRoute, extra: Partial<NavItem> = {}): NavItem {
  return {
    href: route.href,
    label: route.label,
    icon: route.icon,
    hint: route.description,
    ...extra,
  };
}

function groupByIds(ids: string[], extras: Record<string, Partial<NavItem>> = {}): NavItem[] {
  return ids
    .map((id) => NAV_REGISTRY.find((route) => route.id === id))
    .filter((route): route is NavRoute => Boolean(route))
    .map((route) => toItem(route, extras[route.id] ?? {}));
}

/** Espace de travail — centre de gravité « Conversations ». */
export const WORKSPACE: NavItem[] = groupByIds(["conversations", "projects", "workflows", "files", "knowledge", "connectors", "library", "missions", "team"], {
  conversations: { shortcut: "C" },
});

/** Agents & automatisation (surfaces transverses). */
export const AGENTS: NavItem[] = [
  ...groupByIds(["schedules", "live"]),
  { href: "/studio/agents", label: "Agents & chat", icon: "✦", hint: "Personnaliser et dialoguer avec vos agents" },
  { href: "/observability", label: "Observabilité", icon: "∿", hint: "Traces, coûts et alertes de vos agents" },
  { href: "/integrations", label: "Intégrations", icon: "⧉", hint: "Connecter vos services externes" },
];

/** Ressources. */
export const LIBRARY: NavItem[] = [
  ...groupByIds(["memory", "marketplace"]),
  ...groupByIds(["billing", "settings"]),
];

/** Espaces spécialisés (filtrés par rôle côté AppNav). */
export const DEVELOPER: NavItem[] = [
  { href: "/developer", label: "Developer Studio", icon: "⌥", hint: "Projets, build, connecteurs, API et extensions", requiredRole: "developer" },
];

export const ADMIN: NavItem[] = [
  { href: "/admin", label: "Administration", icon: "⛨", hint: "Vue plateforme, utilisateurs, modération et audit", requiredRole: "admin" },
];

export const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  { title: "Espace de travail", items: WORKSPACE },
  { title: "Agents & automatisation", items: AGENTS },
  { title: "Ressources", items: LIBRARY },
  { title: "Développeur", items: [...DEVELOPER, ...ADMIN] },
];

/**
 * Index plat consommé par la palette de navigation (⌘K), dérivé du
 * NavRegistry (filtrage par rôle inclus). Conservé pour compatibilité.
 */
export const NAV_COMMAND_INDEX: Array<NavItem & { group: string }> = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.title })),
);

/**
 * Index complet filtré par rôle — utilisé par la palette pour exposer aussi
 * les entrées admin/developer aux comptes autorisés.
 */
export function commandIndexForRole(role: "user" | "developer" | "admin"): Array<NavItem & { group: string }> {
  return navCommandIndex(role).map((route) => ({
    href: route.href,
    label: route.label,
    icon: route.icon,
    hint: route.description,
    group: route.group,
  }));
}
