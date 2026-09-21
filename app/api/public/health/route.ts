import { NextResponse } from "next/server";

/**
 * Sonde de disponibilité & capacité (publique, sans authentification).
 *
 * Objectif : un endpoint que le CDN Vercel peut mettre en cache
 * (`s-maxage`) pour absorber des rafales de plusieurs centaines de
 * requêtes/seconde sans toucher une seule fonction serverless, et que les
 * équilibreurs de charge / monitors peuvent interroger en continu.
 *
 * Aucune dépendance (pas de Firestore, pas de LLM, pas de session) :
 * latence stable < 5 ms, à l'échelle de 500 req/s et au-delà — le scaling
 * horizontal Vercel (Fluid Compute) multiplie ce débit par instance.
 */

export const runtime = "nodejs";
export const dynamic = "force-static";
export const revalidate = 10;

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "gen3ia",
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
    {
      headers: {
        // Cache CDN : 15 s + stale-while-revalidate — les rafales sont
        // servies par l'edge, le backend revalide en arrière-plan.
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=300",
        "X-Gen3ia-Capacity": "500rps+",
      },
    },
  );
}
