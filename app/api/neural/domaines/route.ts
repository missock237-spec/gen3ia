import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { statsDatasets } from "@/lib/neural/training/domaines";
import { getNeuralRuntime } from "@/lib/neural/runtime";
import { ZONE_DOMAINES } from "@/lib/neural/core/types";

/**
 * LES 18 DOMAINES DE GEN3 — inventaire honnête des datasets
 * (training/gen3-domain-datasets : 18 × 100 000 lignes bilingues FR/EN
 * générées, 120 échantillons/domaine commis) et de l'état APPRIS du cerveau
 * (synapses dans la couche des domaines, neurones 100-135).
 *
 * GET : liste des 18 domaines + disponibilité des données + couche apprise.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);

    const datasets = await statsDatasets();
    const runtime = getNeuralRuntime();

    // État réel de la couche des domaines : synapses touchant 100-135.
    let synapsesDomaine = 0;
    for (const synapse of runtime.reseau.synapses) {
      if (
        synapse.sourceId >= ZONE_DOMAINES.debut ||
        synapse.targetId >= ZONE_DOMAINES.debut
      ) {
        synapsesDomaine += 1;
      }
    }

    return NextResponse.json({
      datasets,
      coucheDomaines: {
        synapses: synapsesDomaine,
        neurones: `${ZONE_DOMAINES.debut}-${ZONE_DOMAINES.debut + 35}`,
        tailleReseau: runtime.reseau.config.size,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}
