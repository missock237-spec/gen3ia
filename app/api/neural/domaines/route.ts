import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { statsDatasets } from "@/lib/neural/training/domaines";
import { getNeuralRuntime } from "@/lib/neural/runtime";
import { ZONE_DOMAINES } from "@/lib/neural/core/types";
// it.59 — LA VOCATION DE GEN3 : les 19 domaines déclarés (charte) sont
// exposés à côté des 18 datasets d'entraînement — source de vérité unique.
import { DOMAINES_VOCATION, MISSION_GEN3, NB_DOMAINES_VOCATION } from "@/lib/gen3/vocation";

/**
 * LES DOMAINES DE GEN3 — inventaire honnête :
 *  - VOCATION (it.59) : les 19 domaines pour lesquels gen3 a été CRÉÉ pour
 *    exécuter des tâches (charte mission + tâches + outils réels) ;
 *  - DATASETS : les 18 datasets d'entraînement (training/gen3-domain-datasets :
 *    18 × 100 000 lignes bilingues FR/EN générées, 120 échantillons/domaine
 *    commis) et l'état APPRIS du cerveau (synapses couche domaines, 100-135).
 *
 * GET : vocation (19) + datasets (18) + disponibilité des données + couche apprise.
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
      // it.59 — LA VOCATION : les 19 domaines déclarés de gen3 (charte).
      vocation: {
        mission: MISSION_GEN3,
        total: NB_DOMAINES_VOCATION,
        domaines: DOMAINES_VOCATION.map((domaine) => ({
          id: domaine.id,
          label: domaine.label,
          mission: domaine.mission,
          taches: domaine.taches,
          outils: domaine.outils,
        })),
      },
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
