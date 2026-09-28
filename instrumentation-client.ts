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
