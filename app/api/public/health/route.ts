import { NextResponse } from "next/server";

/**
 * Sonde de disponibilité (publique, sans authentification).
 *
 * Objectif : un endpoint que les monitors / équilibreurs de charge peuvent
 * interroger en continu et qui reflète l'état VRAI de l'instant — chaque
 * requête atteint réellement la fonction serverless.
 *
 * IMPORTANT (audit 25-e) : cette sonde était servie en `force-static` et
 * mise en cache par le CDN (x-vercel-cache: HIT/STALE, age 85–269 s). Un
 * plantage réel restait donc invisible jusqu'à plusieurs minutes : angle
 * mort de supervision inacceptable pour un healthcheck. Elle est donc
 * `force-dynamic` + `Cache-Control: no-store` : fraîcheur garantie, au prix
 * d'une exécution serverless par requête (aucune dépendance — Firestore,
 * LLM, session — latence stable de quelques millisecondes).
 *
 * Aucune dépendance (pas de Firestore, pas de LLM, pas de session) :
 * latence stable < 5 ms — le scaling horizontal Vercel (Fluid Compute)
 * absorbe les rafales sans dégrader la réponse.
 */

export const runtime = "nodejs";
// Route handler Next 16 : force-dynamic interdit tout cache (CDN comme
// navigateur) — la sonde est recalculée à chaque requête.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "gen3ia",
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
    {
      headers: {
        // Supervision : réponse toujours fraîche, jamais servie par l'edge.
        "Cache-Control": "no-store",
        "X-Gen3ia-Capacity": "500rps+",
      },
    },
  );
}
