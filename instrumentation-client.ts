import { installSentryBridge } from "@/lib/telemetry/sentry-bridge-client";

/**
 * Instrumentation Sentry NAVIGATEUR (convention Next 15 :
 * instrumentation-client.ts à la racine, chargé avant hydratation).
 *
 * L'init complète est déléguée au pont asynchrone (Task 40, ADR-005) :
 * file d'erreurs synchrone ~1 kB + SDK dynamique au repos — le coût au
 * chemin critique est nul (mesure A/B : init synchrone = +54 kB gzip par
 * page). Toute la configuration (DSN, tunnel /monitoring, scrubbing,
 * ignoreErrors) vit dans lib/telemetry/sentry-bridge-client.ts.
 */
installSentryBridge();

/**
 * Hook d'instrumentation des navigations App Router (exigé par
 * @sentry/nextjs, message "ACTION REQUIRED" du build sinon). Convention
 * officielle : `export const onRouterTransitionStart =
 * Sentry.captureRouterTransitionStart` — MAIS cet export exige un import
 * statique du SDK, qui réintroduirait les +54 kB gzip éliminés par le pont.
 *
 * Délégation paresseuse équivalente (Task 41) : le hook est un simple
 * relais — tant que le SDK est au repos (pré-init), les navigations ne
 * sont de toute façon pas tracées par personne ; une fois le SDK chargé
 * (ready), l'import dynamique est un cache-hit microtask et la transition
 * est transmise à captureRouterTransitionStart. Le SDK détecte la fonction
 * exportée à son init et branche l'instrumentation des navigations.
 */
export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  if (typeof window === "undefined" || !window.__g3Sentry?.ready) return;
  void import("@sentry/nextjs")
    .then((Sentry) => Sentry.captureRouterTransitionStart?.(url, navigationType))
    .catch(() => {});
}
