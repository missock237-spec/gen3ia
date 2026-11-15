import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { orchestrateurEssaim } from "@/lib/essaim-media/orchestrateur";
import { assurerBatteur } from "@/lib/essaim-media/onde-porteuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * /api/essaim/job/[id] — SUIVI du job par l'agent DEMANDEUR.
 *
 * L'agent qui a soumis la requête sonde ici la progression RÉELLE (par
 * fragments) : l'IA centrale répond avec l'état de chaque part, le nombre
 * de relances (transparence totale sur les déconnexions gérées) et, une
 * fois les signaux associés, la livraison {message, artifact} — la même
 * forme que /api/media/webgpu-complete : le hook chat la consomme tel quel.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  assurerBatteur({
    surveiller: () => orchestrateurEssaim.surveiller(),
    attribuer: () => orchestrateurEssaim.attribuer(),
  });

  // Chaque sondage est aussi l'occasion d'un passage de sentinelle : même
  // si le batteur central était arrêté (redémarrage process), les
  // déconnexions brusques sont détectées ici.
  orchestrateurEssaim.surveiller();

  const job = orchestrateurEssaim.étatJob(id, guard.context.userId);
  if (!job) {
    return NextResponse.json(
      { success: false, error: "Job d'essaim inconnu (ou non possédé)." },
      { status: 404 },
    );
  }

  const terminés = job.fragments.filter((f) => f.état === "termine").length;
  const total = job.fragments.length;
  const pourcent = Math.round((terminés / total) * (job.état === "termine" ? 100 : 92));

  return NextResponse.json({
    success: true,
    job: {
      jobId: job.jobId,
      état: job.état,
      kind: job.kind,
      prompt: job.prompt.slice(0, 200),
      fragments: total,
      terminés,
      pourcent,
      relances: job.relances.length,
      erreur: job.erreur,
      détailFragments: job.fragments.map((f) => ({
        index: f.index,
        état: f.état,
        génération: f.génération,
        tailleRésultat: f.tailleRésultat,
      })),
      résultat: job.résultat,
      livraison: job.livraison,
    },
  });
}
