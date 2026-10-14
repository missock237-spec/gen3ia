/**
 * Erreurs typées des connecteurs Composio (Task 143 — axe 1).
 *
 * Objectif : quand un agent a besoin d'une API que l'utilisateur n'a PAS
 * encore autorisée via les connecteurs, l'échec doit être IDENTIFIABLE de
 * bout en bout (runtime → moteur conversationnel → message → UI) pour
 * déclencher la carte « Connecter <App> » avec le bouton de connexion OAuth
 * — au lieu d'une erreur générique noyée dans la timeline.
 *
 * L'erreur transite par `executeTool` qui ne conserve que `error.message` :
 * le marqueur `[CONNECTOR_MISSING:<toolkit>]` en tête du message garantit la
 * reconnaissance SANS dépendre d'une classe d'erreur qui serait aplatie
 * en string au passage. `parseConnectorMissing()` fait la retro-analyse.
 */

/** Marqueur sérialisable placé en tête du message d'erreur. */
const MISSING_MARKER = "[CONNECTOR_MISSING:";

/** Toolkit Composio : slug normalisé (minuscules, a-z0-9_). */
const TOOLKIT_RE = /^[a-z0-9_]{2,64}$/;

export interface MissingConnector {
  /** Slug Composio à passer à POST /api/integrations/composio/connect. */
  toolkit: string;
}

export class ConnectorMissingError extends Error {
  readonly code = "CONNECTOR_MISSING" as const;
  readonly toolkit: string;

  constructor(toolkit: string) {
    const normalized = toolkit.trim().toLowerCase();
    super(
      `[CONNECTOR_MISSING:${normalized}] Ce service (${normalized}) n'est pas encore connecté à votre compte Gen3ia — ` +
        "l'utilisateur voit un bouton de connexion sous cette réponse ; expliquez-lui qu'il doit cliquer dessus pour autoriser l'accès, puis reformulez ou faites réessayer l'action.",
    );
    this.name = "ConnectorMissingError";
    this.toolkit = normalized;
  }
}

/**
 * Reconnaît un message d'erreur de connecteur manquant (y compris après
 * stringification par le sérialiseur d'outils). Retourne le toolkit à
 * proposer à la connexion, ou null si l'erreur est d'une autre nature.
 */
export function parseConnectorMissing(message: string | null | undefined): MissingConnector | null {
  if (!message) return null;
  const start = message.indexOf(MISSING_MARKER);
  if (start < 0) return null;
  const end = message.indexOf("]", start);
  if (end <= start) return null;
  const toolkit = message.slice(start + MISSING_MARKER.length, end);
  if (!TOOLKIT_RE.test(toolkit)) return null;
  return { toolkit };
}

/** Dédupe une liste de toolkits en préservant l'ordre d'apparition. */
export function uniqueToolkits(toolkits: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const toolkit of toolkits) {
    const normalized = toolkit.trim().toLowerCase();
    if (!TOOLKIT_RE.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
