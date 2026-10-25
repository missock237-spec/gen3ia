import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { formaterTraceparent } from "./trace-w3c";

/**
 * CONTEXTE DE REQUÊTE — AsyncLocalStorage (Task K — corrélation des logs).
 *
 * PROBLÈME : le middleware pose le trace-id dans les EN-TÊTES (réponses +
 * requestHeaders aval), mais les lignes de log pino ne le portent PAS
 * automatiquement — il fallait un `traceLogger(traceId, …)` manuel à chaque
 * appel. Les routes qui oublient produisent des logs sans corrélation.
 *
 * SOLUTION : un AsyncLocalStorage process-local rempli au point d'entrée
 * node runtime d'une requête. Le mixin pino (lib/observability/logger.ts)
 * lit ce contexte et injecte automatiquement traceId/orgId/userId/route
 * dans CHAQUE ligne de log émise pendant la requête.
 *
 * ⚠️ LIMITE STRUCTURELLE (documentée dans docs/sre/tracing.md) : le
 * MIDDLEWARE ne peut PAS remplir ce contexte — même au runtime « nodejs »,
 * il s'exécute dans un contexte d'isolation distinct des route handlers
 * (l'AsyncLocalStorage ne traverse pas la frontière). Le remplissage se
 * fait côté route : helper `withContexteRoute` (lib/observability/span-
 * serveur.ts) OU log d'erreur centralisé `onRequestError`
 * (instrumentation.ts). Les exécutions d'agents (lib/observability/otel.ts)
 * retiennent le traceId courant en repli quand les métadonnées sont muettes.
 *
 * Coût mémoire : un store par requête en cours (~1 objet) — libéré
 * automatiquement en fin de chaîne async. AUCUN impact quand il n'est pas
 * rempli (getStore() → undefined → mixin retourne {}).
 */

export interface ContexteRequete {
  /** Identifiant de corrélation Gen3ia (x-gen3ia-trace-id / traceparent). */
  traceId: string;

  /** Chemin de la route (classe ou pathname borné — jamais la query). */
  route?: string;

  /** Organisation connue après authentification (corrélation multi-tenant). */
  orgId?: string;

  /** Utilisateur connu après authentification. */
  userId?: string;

  /** Conversation en cours (chat) — corrélation bout-en-bout des logs d'un
   *  tour conversationnel avec le traceId et la facturation. */
  conversationId?: string;
}

const als = new AsyncLocalStorage<ContexteRequete>();

/**
 * Exécute `fn` avec le contexte de requête fourni — TOUTE la chaîne async
 * en dessous (await, callbacks, promesses) hérite du contexte.
 */
export function executerAvecContexteRequete<T>(
  contexte: ContexteRequete,
  fn: () => T,
): T {
  return als.run(contexte, fn);
}

/** Contexte courant (undefined hors requête instrumentée). */
export function contexteRequeteCourant(): ContexteRequete | undefined {
  return als.getStore();
}

/** traceId de la requête courante (undefined hors requête instrumentée). */
export function traceIdRequeteCourant(): string | undefined {
  return als.getStore()?.traceId;
}

/**
 * Enrichit le contexte COURANT après coup (ex. orgId/userId connus une fois
 * l'authentification passée) — mutation in-place du store : les logs
 * suivants de la même requête portent la dimension ajoutée. Hors requête
 * instrumentée : no-op silencieux (jamais d'exception).
 */
export function definirContexteRequeteTenant(
  partial: Partial<Omit<ContexteRequete, "traceId">>,
): void {
  const courant = als.getStore();
  if (!courant) return;
  if (partial.route) courant.route = partial.route.slice(0, 256);
  if (partial.orgId) courant.orgId = partial.orgId.slice(0, 128);
  if (partial.userId) courant.userId = partial.userId.slice(0, 128);
  if (partial.conversationId) courant.conversationId = partial.conversationId.slice(0, 128);
}

/**
 * Champs de corrélation à injecter dans pino — appelé par le `mixin` du
 * logger pour CHAQUE ligne de log. Retour {} hors contexte (coût ~négligable).
 * Les clés explicites d'un `logger.child()`/contexte d'appel gardent la
 * priorité côté pino : le mixin ne fait qu'APPORTER la corrélation absente.
 */
export function contextePino(): Record<string, string> {
  const contexte = als.getStore();
  if (!contexte) return {};
  const champs: Record<string, string> = {};
  if (contexte.traceId) champs.traceId = contexte.traceId;
  if (contexte.orgId) champs.orgId = contexte.orgId;
  if (contexte.userId) champs.userId = contexte.userId;
  if (contexte.route) champs.route = contexte.route;
  if (contexte.conversationId) champs.conversationId = contexte.conversationId;
  return champs;
}

/**
 * En-tête `traceparent` W3C à poser sur un APPEL SORTANT (propagation
 * inter-services, Task K) : dérivé du traceId de la requête courante avec
 * un NOUVEAU span-id (chaque saut réseau = un span distinct du même arbre).
 * Undefined hors requête instrumentée — l'appelant omet simplement l'en-tête
 * (comportement historique préservé).
 */
export function traceparentPourPropagation(
  options: { spanId?: string; flags?: string } = {},
): string | undefined {
  const traceId = als.getStore()?.traceId;
  if (!traceId) return undefined;
  try {
    return formaterTraceparent(traceId, options);
  } catch {
    return undefined; // fire-and-forget : la propagation ne casse jamais un appel.
  }
}
