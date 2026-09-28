/**
 * Pont Sentry NAVIGATEUR — file synchrone + SDK chargé en asynchrone.
 * (Task 40, ADR-005)
 *
 * Mesure A/B : l'init synchrone de @sentry/nextjs coûte +54 kB gzip dans
 * le chunk partagé de CHAQUE page (/layout 178 → 232 kB) — inacceptable
 * pour l'identité performance Gen3ia (Task 38 : First Load −42 %). Ce
 * pont élimine 100 % du coût au chemin critique SANS perdre d'erreurs :
 *
 *   1. SYNCHRONE (installé par instrumentation-client.ts avant hydratation) :
 *      une file bornée capture erreurs/rejets globaux et expose
 *      `window.__g3Sentry.capture()` pour les boundaries (error.tsx,
 *      global-error.tsx). Coût : ~1 kB, zéro dépendance.
 *   2. ASYNCHRONE (au repos navigateur) : le SDK complet est importé
 *      dynamiquement, initialisé (tunnel /monitoring, scrubbing), puis la
 *      file est REJOUÉE — les erreurs d'hydratation (les plus fréquentes
 *      et précieuses) sont couvertes.
 *
 * Conservé : erreurs client complètes, traces post-chargement, contexte des
 * boundaries. Décalé : spans de tracing des premières secondes (l'observa-
 * bilité p95 reste couverte côté serveur — instrumentation.ts, 15 %).
 */

interface G3SentryBridge {
  /** Capture d'une exception applicative (boundaries) — toujours sûr. */
  capture: (error: unknown, tags?: Record<string, string>) => void;
  /** File des événements pré-init (rejouée au chargement du SDK). */
  queue: Array<{ kind: "error" | "rejection"; args: unknown[]; tags?: Record<string, string> }>;
  /** true quand le SDK est initialisé (diagnostic/tests). */
  ready: boolean;
}

declare global {
  interface Window {
    __g3Sentry?: G3SentryBridge;
  }
}

const QUEUE_LIMIT = 25;

/**
 * Extrait l'Error d'un événement de la file. Dans un navigateur, les
 * événements globaux sont des ErrorEvent (propriété .error) — PAS des
 * Error : sans extraction, la rejeu perdrait toutes les erreurs globales
 * pré-init (bug attrapé par le test du pont).
 */
function extractError(event: { args: unknown[] }): Error | null {
  const first = event.args[0] as { error?: unknown } | Error | undefined;
  if (first instanceof Error) return first;
  const candidate = (first as { error?: unknown } | undefined)?.error;
  return candidate instanceof Error ? candidate : null;
}

/** Raison lisible (PromiseRejectionEvent.reason ou fallback). */
function extractReason(event: { args: unknown[] }): string {
  const first = event.args[0] as { reason?: unknown } | undefined;
  const reason = (first as { reason?: unknown } | undefined)?.reason ?? first;
  try {
    return typeof reason === "string" ? reason : String(reason ?? "raison inconnue");
  } catch {
    return "raison inconnue";
  }
}

export function installSentryBridge(): void {
  if (typeof window === "undefined") return;
  if (window.__g3Sentry) return;

  const bridge: G3SentryBridge = {
    ready: false,
    queue: [],
    capture(error, tags) {
      if (bridge.ready) {
        // SDK prêt : envoi direct (l'import est résolu, micro-délai).
        void import("@sentry/nextjs")
          .then((Sentry) => {
            Sentry.captureException(error, { tags: { surface: "client", ...tags } });
          })
          .catch(() => {});
        return;
      }
      if (bridge.queue.length >= QUEUE_LIMIT) {
        bridge.queue.shift(); // burst : l'événement le plus ancien est sacrifié
      }
      bridge.queue.push({ kind: "error", args: [error], tags });
    },
  };

  const onGlobalError = (...args: unknown[]) => {
    if (bridge.queue.length < QUEUE_LIMIT) bridge.queue.push({ kind: "error", args });
  };
  const onRejection = (...args: unknown[]) => {
    if (bridge.queue.length < QUEUE_LIMIT) bridge.queue.push({ kind: "rejection", args });
  };

  window.addEventListener("error", onGlobalError, true);
  window.addEventListener("unhandledrejection", onRejection, true);
  window.__g3Sentry = bridge;

  // SDK au repos : requestIdleCallback évite de concurrencer l'hydratation
  // et l'interaction initiale (LCP/INP préservés) ; timeout = filet pour
  // les pages sans temps mort.
  const loadSdk = () => {
    void import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.init({
          dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,
          tunnel: "/monitoring",
          environment:
            process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
          release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
          sendDefaultPii: false,
          // Tracing client léger après chargement (navigations + fetch) ;
          // 10 % suffit pour les p95, le serveur garde 15 % (TTFB, API).
          tracesSampleRate: 0.1,
          // Erreurs tiers (iframes AdSense, popups OAuth) non attribuables
          // à notre code — bruit supprimé à la source.
          ignoreErrors: [
            /adsbygoogle/i,
            /googlesyndication/i,
            /doubleclick/i,
            "ResizeObserver loop",
            /Non-Error promise rejection captured/i,
          ],
        });

        // Rejoue la file : erreurs d'hydratation + événements globaux
        // (extraction ErrorEvent.error / PromiseRejectionEvent.reason).
        for (const event of bridge.queue) {
          const error = event.kind === "error" ? extractError(event) : null;
          if (error) {
            Sentry.captureException(error, {
              tags: { surface: "client-preinit", ...(event.tags ?? {}) },
            });
          } else {
            Sentry.captureMessage(
              event.kind === "rejection" ? "rejet de promesse pré-init" : "erreur pré-init",
              {
                level: "warning",
                tags: { surface: "client-preinit" },
                extra: { raison: extractReason(event) },
              },
            );
          }
        }
        bridge.queue.length = 0;
        bridge.ready = true;

        window.removeEventListener("error", onGlobalError, true);
        window.removeEventListener("unhandledrejection", onRejection, true);
      })
      .catch(() => {
        // SDK non chargeable (réseau/bloqueur) : la file reste locale,
        // aucun impact produit — la console reste le repli.
      });
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(loadSdk, { timeout: 4000 });
  } else {
    setTimeout(loadSdk, 1500);
  }
}

/** API canonique pour les boundaries d'erreur client. */
export function captureClientException(error: unknown, tags?: Record<string, string>): void {
  if (typeof window === "undefined") return;
  window.__g3Sentry?.capture(error, tags);
}
