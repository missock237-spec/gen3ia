import * as Sentry from "@sentry/nextjs";

import { traceIdGen3iaDepuisTraceparent } from "./lib/observability/trace-w3c";

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

    // Export OpenTelemetry (Task 59) : UNIQUEMENT si l'endpoint OTLP est
    // défini (Datadog, Grafana, collecteur interne). Import dynamique du
    // pont — sans la variable, aucun module OTel n'est chargé. Task K :
    // l'init démarre aussi le sampler ParentBased(TraceIdRatioBased) piloté
    // par OTEL_TRACES_SAMPLER_ARG (défaut 0.1).
    try {
      const { initOtel, isOtelExportEnabled } = await import("./lib/observability/otel");
      if (isOtelExportEnabled()) await initOtel();
    } catch {
      /* l'observabilité ne doit jamais empêcher le service de démarrer. */
    }

    // AUTO-APPRENTISSAGE (hubs HF + Kaggle) : la boucle autonome est armée
    // ICI, au boot réel du serveur — Gen3ia s'entraîne seule dès son
    // lancement. Import dynamique : le module neuronal n'est chargé que
    // quand le serveur tourne, et AUCUN échec ici ne peut empêcher le
    // démarrage (désactivable par AUTO_APPRENTISSAGE=0).
    try {
      const { demarrerAutoApprentissage } = await import("./lib/entrainement-auto");
      demarrerAutoApprentissage();
    } catch (erreur) {
      console.warn(
        "[INSTRUMENTATION] Auto-apprentissage non armé (non fatal) :",
        erreur instanceof Error ? erreur.message : String(erreur),
      );
    }
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

/**
 * TraceId Gen3ia depuis les EN-TÊTES de la requête fautive (Task K) : le
 * middleware pose le couple x-gen3ia-trace-id + traceparent — l'un des deux
 * suffit. Extraction défensive (l'objet request de Sentry ressemble à un
 * Request mais reste un type inconnu) : jamais d'exception depuis ce hook.
 */
function extraireTraceIdEnTetes(enTetes: unknown): string | undefined {
  try {
    const get = (enTetes as { get?: (nom: string) => string | null } | undefined)?.get?.bind(enTetes);
    if (!get) return undefined;
    const direct = get("x-gen3ia-trace-id")?.trim();
    if (direct && /^[a-zA-Z0-9_-]{8,64}$/.test(direct)) return direct;
    return traceIdGen3iaDepuisTraceparent(get("traceparent"));
  } catch {
    return undefined;
  }
}

/**
 * Les 401 AUTH_REQUIRED sont des réponses métier attendues (session absente,
 * expirée ou cookie non disponible), pas des incidents applicatifs. Next.js
 * transmet néanmoins les erreurs levées par les route handlers à
 * `onRequestError`, ce qui polluait Sentry et les clusters runtime Vercel.
 * On les filtre ici tout en conservant la capture de toutes les autres erreurs.
 *
 * CORRÉLATION LOGS (Task K) : chaque erreur capturée produit AUSSI une ligne
 * pino `request.error` portant le traceId extrait des en-têtes — l'objectif
 * minimal de corrélation (traceId présent dans les logs d'erreur même quand
 * la route n'a pas adopté withContexteRoute). Le tag Sentry gen3ia.trace_id
 * relie l'événement Sentry au même identifiant.
 */
export async function onRequestError(error: unknown, request: Parameters<typeof Sentry.captureRequestError>[1], context: Parameters<typeof Sentry.captureRequestError>[2]): Promise<void> {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  const status = candidate?.status;
  const code = candidate?.code;

  if (status === 401 || code === "AUTH_REQUIRED") {
    return;
  }

  const traceId = extraireTraceIdEnTetes((request as { headers?: unknown })?.headers);

  if (traceId) {
    try {
      // Import DYNAMIQUE : instrumentation.ts est bundlé pour les DEUX
      // runtimes (nodejs + edge) — le logger (pino, server-only) ne peut
      // pas y être importé statiquement.
      const { logger } = await import("./lib/observability/logger");
      let chemin: string | undefined;
      try {
        chemin = new URL((request as Request).url).pathname;
      } catch {
        chemin = undefined;
      }
      logger.error(
        {
          event: "request.error",
          traceId,
          route: chemin,
          status: typeof status === "number" ? status : undefined,
          errorCode: typeof code === "string" ? code : undefined,
        },
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      /* la corrélation ne doit JAMAIS masquer la capture Sentry. */
    }
    try {
      Sentry.withScope((scope) => {
        scope.setTag("gen3ia.trace_id", traceId);
        Sentry.captureRequestError(error, request, context);
      });
      return;
    } catch {
      /* repli ci-dessous. */
    }
  }

  Sentry.captureRequestError(error, request, context);
}
