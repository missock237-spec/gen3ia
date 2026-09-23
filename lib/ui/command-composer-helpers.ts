import {
  AUTHORIZATION_MODES,
  DEFAULT_AUTHORIZATION_MODE,
  type AuthorizationMode,
} from "@/lib/security/authorization-mode";

/**
 * Logique pure du CommandComposer (séparée du JSX pour être testable) :
 * détection des déclencheurs « @ » et « / », filtrage des commandes,
 * navigation clavier dans les menus.
 */

export type MentionItem = {
  toolkit: string;
  label: string;
  description: string;
  category?: string;
  connected?: boolean;
};

export type ComposerCommand = {
  id: string;
  label: string;
  description?: string;
  /** Exécutée quand la commande est choisie (le déclencheur /query est retiré du texte). */
  run: () => void;
};

/** Recherche « @ » en fin de saisie → ouvre le sélecteur de compétences/connecteurs. */
export function detectMentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([a-z0-9_-]{0,32})$/i.exec(text);
  return match ? match[1] : null;
}

/** Recherche « / » en fin de saisie → ouvre le menu de commandes. */
export function detectCommandQuery(text: string): string | null {
  const match = /(?:^|\s)\/([a-z0-9_-]{0,32})$/i.exec(text);
  return match ? match[1] : null;
}

export function filterCommands(commands: ComposerCommand[], query: string): ComposerCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  return commands.filter((command) =>
    command.label.toLowerCase().includes(needle)
    || command.id.toLowerCase().includes(needle)
    || (command.description ?? "").toLowerCase().includes(needle),
  );
}

/** Retire le déclencheur « @query » (ou « /query ») de fin de texte. */
export function stripTrigger(text: string, trigger: "@" | "/"): string {
  const pattern = trigger === "@" ? /@([a-z0-9_-]{0,32})$/i : /\/([a-z0-9_-]{0,32})$/i;
  return text.replace(pattern, "").trimEnd();
}

export function filterMentions(items: MentionItem[], query: string): MentionItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    item.label.toLowerCase().includes(needle)
    || item.toolkit.toLowerCase().includes(needle)
    || (item.description ?? "").toLowerCase().includes(needle),
  );
}

/**
 * Déplace l'index surligné d'un menu (navigation ↑/↓, bouclage inclus).
 * Renvoie -1 si la liste est vide.
 */
export function moveHighlight(current: number, direction: 1 | -1, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

export { AUTHORIZATION_MODES, DEFAULT_AUTHORIZATION_MODE };
export type { AuthorizationMode };
