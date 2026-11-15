import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorStatus } from "@/lib/security/http-errors";
import { executionLogger } from "@/lib/observability/logger";

import { resetBrain } from "@/lib/neural/runtime";

/**
 * RESET NEURONAL (admin) — remise à zéro complète du cerveau : purge du
 * fichier persisté (var/neural/brain-v1.json), remise à zéro du registre
 * lexical, reconstruction intégrale du runtime (réseau seedé à l'état
 * initial). Utile pour rejouer un entraînement depuis un état vierge.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const admin = await requireAdmin(request);

    const runtime = resetBrain();
    const stats = runtime.reseau.getStats();

    executionLogger({ requestId: "neural-reset", userId: admin.uid }).info(
      "Cerveau neuronal réinitialisé",
    );

    return NextResponse.json({
      reinitialise: true,
      cerveau: {
        nbNeurones: stats.nbNeurones,
        nbSynapses: stats.nbSynapses,
        creeLe: runtime.creeLe,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}
