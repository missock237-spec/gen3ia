/**
 * MOTEUR DE VARIABLES DE PROMPTS (prompts système avancés).
 *
 * Les chartes et instructions d'agents peuvent contenir des jetons
 * {{variable}} résolus à CHAQUE requête avec l'état réel du moment :
 * date/heure/weekday/fuseau, utilisateur courant, agent courant. Avant ce
 * module, aucun prompt système n'avait accès à ces variables — chaque
 * moteur assemblait des chaînes statiques.
 *
 * Sémantique honnête :
 *  - un jeton connu est remplacé par sa valeur RÉELLE (jamais un placeholder) ;
 *  - un jeton inconnu est SUPPRIMÉ et signalé dans `unresolved` (il ne
 *    fuit jamais littéralement dans le prompt final) ;
 *  - le contexte est Optional par variable : absent = jeton supprimé.
 */

export interface PromptVariableContext {
  /** Nom affiché de l'utilisateur connecté (undefined = jetons user.* supprimés). */
  userName?: string;
  userEmail?: string;
  agentName?: string;
  agentType?: string;
  agentTypeLabel?: string;
  /** Fuseau IANA du client (sinon UTC explicite). */
  timezone?: string;
  /** Horloge injectable pour les tests (défaut : maintenant). */
  now?: Date;
}

const WEEKDAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

const TOKEN_PATTERNS: Array<{ token: string; resolve: (context: PromptVariableContext) => string | undefined }> = [
  { token: "user.name", resolve: (c) => c.userName?.trim() || undefined },
  { token: "user.email", resolve: (c) => c.userEmail?.trim() || undefined },
  { token: "agent.name", resolve: (c) => c.agentName?.trim() || undefined },
  { token: "agent.type", resolve: (c) => c.agentTypeLabel?.trim() || c.agentType?.trim() || undefined },
  { token: "timezone", resolve: (c) => (c.timezone?.trim() || "UTC") },
  { token: "date", resolve: (c) => formatDate(c) },
  { token: "time", resolve: (c) => formatTime(c) },
  { token: "datetime", resolve: (c) => `${formatDate(c)} ${formatTime(c)} (${c.timezone?.trim() || "UTC"})` },
  { token: "weekday", resolve: (c) => formatWeekday(c) },
  { token: "year", resolve: (c) => String(formatParts(c).year) },
];

function formatParts(context: PromptVariableContext) {
  const timezone = context.timezone?.trim() || "UTC";
  const now = context.now ?? new Date();
  try {
    const parts = new Intl.DateTimeFormat("fr-FR", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const weekdayShort = get("weekday").toLowerCase().slice(0, 3);
    const weekdayMap: Record<string, number> = { dim: 0, lun: 1, mar: 2, mer: 3, jeu: 4, ven: 5, sam: 6 };
    return {
      year: Number(get("year")) || now.getUTCFullYear(),
      date: `${get("day")}/${get("month")}/${get("year")}`,
      time: `${get("hour")}:${get("minute")}`,
      weekday: WEEKDAYS_FR[weekdayMap[weekdayShort] ?? 0],
    };
  } catch {
    // Fuseau invalide : repli UTC garanti (jamais d'exception au prompt).
    return {
      year: now.getUTCFullYear(),
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 16),
      weekday: WEEKDAYS_FR[now.getUTCDay()],
    };
  }
}

function formatDate(context: PromptVariableContext) {
  return formatParts(context).date;
}

function formatTime(context: PromptVariableContext) {
  return formatParts(context).time;
}

function formatWeekday(context: PromptVariableContext) {
  return formatParts(context).weekday;
}

const TOKEN_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

export interface RenderedPrompt {
  text: string;
  /** Jetons reconnus mais sans valeur fournie, ou inconnus — tous supprimés. */
  unresolved: string[];
}

/** Rend un template avec un dictionnaire de variables plat. */
export function renderPromptTemplate(template: string, variables: Record<string, string>): RenderedPrompt {
  const unresolved = new Set<string>();
  const text = template.replace(TOKEN_REGEX, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = variables[name];
    if (typeof value === "string" && value.length > 0) return value;
    unresolved.add(name);
    return "";
  });
  return { text, unresolved: [...unresolved] };
}

/** Construit le dictionnaire de variables depuis le contexte réel du moment. */
export function buildPromptVariables(context: PromptVariableContext): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const { token, resolve } of TOKEN_PATTERNS) {
    const value = resolve(context);
    if (value !== undefined) variables[token] = value;
  }
  return variables;
}

/** Applique les variables dynamiques à une charte / instructions d'agent. */
export function applyPromptVariables(template: string, context: PromptVariableContext): RenderedPrompt {
  return renderPromptTemplate(template, buildPromptVariables(context));
}
