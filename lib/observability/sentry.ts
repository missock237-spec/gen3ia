import "server-only";

import { safeError } from "./logger";

/**
 * Bridge Sentry serveur — Task 40 : le SDK réel (@sentry/nextjs) est
 * initialisé dans instrumentation.ts (racine). Ce module reste le POINT
 * D'ENTRÉE canonique pour le code applicatif (routes API, services) :
 * - API inchangée pour les ~40 appelants (captureServerException, isSentryConfigured) ;
 * - si le SDK n'est pas initialisé (DSN absent), repli silencieux sur les
 *   logs structurés pino — la source de vérité historique est conservée.
 *
 * Les données sensibles sont masquées AVANT l'envoi : le contexte applicatif
 * passe par la fonction scrubContext (mêmes règles que safeError côté logs).
 */

const SENTRY_DSN = process.env.SENTRY_DSN?.trim() || process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();

/** Clés de contexte jamais envoyées à Sentry (défense en profondeur). */
const FORBIDDEN_CONTEXT_KEYS = /^(authorization|cookie|password|secret|token|apikey|api_key|private_?key|credential)/i;

function scrubContext(context: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_CONTEXT_KEYS.test(key)) {
      clean[key] = "[redacted]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      clean[key] = scrubContext(value as Record<string, unknown>);
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export function isSentryConfigured(): boolean {
  return Boolean(SENTRY_DSN);
}

/**
 * Capture une exception serveur dans Sentry avec contexte applicatif.
 * Never throws : une télémétrie en échec ne doit jamais casser le produit.
 */
export function captureServerException(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  // Repli pino systématique : Sentry peut être absent (DSN vide), les
  // logs structurés restent complets et redactionnés par safeError.
  void import("./logger").then(({ logger }) => {
    logger.error({ error: safeError(error), context }, "server exception");
  });

  if (!SENTRY_DSN) return;

  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureException(error, {
        tags: { surface: "server" },
        extra: scrubContext(context),
      });
    })
    .catch(() => {
      // Import impossible (edge, build) : le log pino ci-dessus suffit.
    });
}

/** Message non-fatal (état dégradé, repli actif) — sans crash applicatif. */
export function captureServerMessage(
  message: string,
  level: "info" | "warning" | "error" = "warning",
  context: Record<string, unknown> = {},
): void {
  if (!SENTRY_DSN) return;
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureMessage(message, {
        level,
        tags: { surface: "server" },
        extra: scrubContext(context),
      });
    })
    .catch(() => {
      // silencieux — télémétrie best-effort
    });
}
