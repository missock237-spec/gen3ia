import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { registreEssaim } from "@/lib/essaim-media/registre";
import { orchestrateurEssaim } from "@/lib/essaim-media/orchestrateur";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/essaim/etat — ÉTAT DE L'ESSAIM pour le panneau du laboratoire :
 * nœuds en ligne, scores GPU, charge, et les jobs actifs de l'utilisateur
 * appelant (jamais ceux des autres — la vie privée des essaims est
 * respectée même dans les diagnostics).
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const essaim = registreEssaim.état();
  const mesJobs = orchestrateurEssaim.jobsDe(guard.context.userId).map((j) => ({
    jobId: j.jobId,
    kind: j.kind,
    état: j.état,
    fragments: j.fragments.length,
    terminés: j.fragments.filter((f) => f.état === "termine").length,
    relances: j.relances.length,
    crééA: j.crééA,
  }));

  return NextResponse.json({
    success: true,
    essaim,
    mesJobs,
    principe:
      "Chaque navigateur connecté porte un agent gen3 (Service Worker en cache). " +
      "L'IA centrale sélectionne les 5 meilleurs GPU à chaque requête, distribue " +
      "une part à chacun via le canal d'ondes (SSE), associe les signaux retournés, " +
      "et relance automatiquement la part de tout agent qui se déconnecte brusquement.",
  });
}
