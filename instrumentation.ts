import * as Sentry from "@sentry/nextjs";

/**
 * Instrumentation Sentry — Task 40 (Rec 4 : observabilité de niveau Google).
 *
 * Un seul module `instrumentation.ts` à la racine couvre les DEUX runtimes
 * serveur de Next 15 (nodejs = routes API + RSC, edge = middleware). Le
 * runtime `edge` ne peut pas importer dynamiquement des modules node, d'où
 * l'init inline branchée par NEXT_RUNTIME.
 *
 * Secret management : le DSN est une donnée PUBLIQUE par conception (il
 * n'authentifie rien, il désigne seulement le projet d'ingestion — même
 * modèle que les clés Web Firebase). Le SENTRY_AUTH_TOKEN, lui, est un
 * secret serveur utilisé UNIQUEMENT au build (upload des source maps).
 *
 * Personal Identifiable Information : désactivé (sendDefaultPii: false) et
 * double scrubbing dans beforeSend — les en-têtes Authorization / cookies /
 * champs secrets potentiellement propagés par un contexte sont retirés.
 * Les données Gen3ia (uid utilisateurs, contenus de conversations) ne
 * quittent JAMAIS la plateforme : seules exceptions techniques + empreintes.
 */

const RELEASE = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;

/** Hosts d'ingestion Sentry autorisés (anti-proxy-ouvert pour le tunnel). */
export const SENTRY_INGEST_HOSTS = [
  "o4511820262473728.ingest.de.sentry.io",
  "ingest.de.sentry.io",
  "ingest.sentry.io",
];

/** Nettoie un événement des données potentiellement sensibles. */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const request = event.request;
  if (request) {
    delete request.cookies;
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        if (/authorization|cookie|secret|token|api-key/i.test(key)) {
          delete request.headers[key];
        }
      }
    }
    if (request.query_string) delete request.query_string;
  }
  return event;
}

function baseOptions() {
  const dsn = process.env.SENTRY_DSN?.trim() || process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return {
    dsn: dsn || undefined,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV,
    release: RELEASE ? `gen3ia@${RELEASE}` : undefined,
    // Aucune donnée utilisateur : PII off + scrubbing défensif.
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubEvent(event);
    },
  } satisfies Sentry.NodeOptions;
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      ...baseOptions(),
      // Tracing serveur : 15 % des requêtes donnent une carte latence/p95
      // exploitable sans surcoût notable d'ingestion. Rehaussable à 1.0
      // temporairement pour une investigation ciblée.
      tracesSampleRate: 0.15,
      // Profilage continu actif uniquement si le vars permis l'autorisent.
      profilesSampleRate: 0.0,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      ...baseOptions(),
      // Le middleware/edge couvre 100 % du trafic (CSP, trace-id) : taux
      // bas pour l'observabilité des en-têtes sans coûts d'ingestion.
      tracesSampleRate: 0.05,
    });
  }
}

/** Capture les erreurs de requête Next (routes API, RSC, server actions). */
export const onRequestError = Sentry.captureRequestError;
