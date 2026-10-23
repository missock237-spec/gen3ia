import "server-only";

import type { NextRequest } from "next/server";

import { executerAvecContexteRequete } from "./contexte-requete";
import { requestTraceId } from "./logger";
import { demarrerSpanServeur } from "./otel";

/**
 * SPAN HTTP SERVEUR MANUELLE + CONTEXTE DE REQUÊTE (Task K).
 *
 * @opentelemetry/instrumentation-http n'est PAS une dépendance du projet
 * (zéro surcoût mémoire tant que OTEL_EXPORTER_OTLP_ENDPOINT est absent) —
 * les spans serveur sont donc créées MANUELLEMENT autour du handler :
 *
 *   export const POST = withContexteRoute(async (request) => { … });
 *
 * Effets, TOUS no-op quand l'export OTel est désactivé :
 *   1. AsyncLocalStorage remplie avec le traceId (réutilise x-gen3ia-trace-id
 *      ou traceparent posés par le middleware) → les logs pino de TOUTE la
 *      chaîne async du handler portent la corrélation automatiquement ;
 *   2. span « http.server » démarrée/fermée avec le statut de la réponse
 *      (ERROR si ≥ 500), attributs bornés en cardinalité ;
 *   3. les métriques/spans d'exécution OTel (lib/observability/otel.ts)
 *      retrouvent le traceId courant même sans métadonnées explicites.
 *
 * Adoption PROGRESSIVE (aucune rupture) : les routes non enveloppées
 * conservent leur comportement actuel — cf. docs/sre/tracing.md § adoption.
 */
export function withContexteRoute<Args extends unknown[]>(
  handler: (request: NextRequest, ...args: Args) => Promise<Response> | Response,
): (request: NextRequest, ...args: Args) => Promise<Response> {
  return async (request: NextRequest, ...args: Args): Promise<Response> => {
    const traceId = requestTraceId(request);
    let chemin: string | undefined;
    try {
      chemin = new URL(request.url).pathname;
    } catch {
      chemin = undefined; // URL malformée : la requête suit son cours.
    }

    const span = demarrerSpanServeur({ route: chemin ?? "(inconnu)", methode: request.method, chemin, traceId });

    try {
      const reponse = await executerAvecContexteRequete(
        { traceId, ...(chemin ? { route: chemin } : {}) },
        () => handler(request, ...args),
      );
      span.end(reponse.status);
      return reponse;
    } catch (error) {
      // Exception levée hors du handler : statut 500 conventionnel —
      // le cadre Next transformera l'erreur, la span marque l'échec.
      span.end(500);
      throw error;
    }
  };
}
