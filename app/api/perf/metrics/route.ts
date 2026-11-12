import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { cacheReponses } from "@/lib/perf/cache-reponses";
import { demarrageCompteursPerf, instantaneCompteursPerf } from "@/lib/perf/compteur";
import { agentSortantActif } from "@/lib/perf/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/perf/metrics — mesures de PERFORMANCE (admin uniquement).
 *
 * CONTENU (100 % numérique, aucun chemin utilisateur brut, aucun secret) :
 *  - `routes` : compteur de requêtes et latence PAR ROUTE NORMALISÉE
 *    (segments identifiants repliés en « :id », cardinalité plafonnée à 256
 *    routes — lib/perf/compteur.ts). p50/p95 par rang le plus proche sur
 *    l'échantillon courant (ring buffer 500). ⚠️ Périmètre : mesure côté
 *    middleware (traitement middleware + statut de SA réponse) — les latences
 *    complètes de route handler ne passent pas ici (logs nginx + /api/metrics
 *    complètent, cf. docs/perf-capacite.md) ;
 *  - `cache` : statistiques du cache de réponses partagé (hits, misses,
 *    coalesced, latence GAGNÉE estimée — lib/perf/cache-reponses.ts) ;
 *  - `poolSortant` : agent HTTP keep-alive actif ou repli fetch global
 *    (lib/perf/pool.ts) ;
 *  - `genereLe` : horodatage de la photographie.
 *
 * PROTECTION : identique aux autres routes admin du dépôt — requireAdmin
 * (Bearer Firebase vérifié OU cookie de session, custom claim admin requis,
 * 403 explicite sinon) via lib/security/admin-access.ts. Réponse no-store :
 * chaque consultation lit l'état COURANT du process.
 *
 * PÉRIMÈTRE D'HONNÊTETÉ : ces compteurs décrivent UNE instance Node. En
 * serverless multi-instances, chaque instance expose SON état process-local
 * (agrégation multi-instances = collecteur externe, hors périmètre du module).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const routes = instantaneCompteursPerf();
  const poolActif = await agentSortantActif();

  return NextResponse.json(
    {
      routes,
      cache: cacheReponses.stats(),
      poolSortant: { keepAliveActif: poolActif },
      compteursDemarreLe: demarrageCompteursPerf(),
      genereLe: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
