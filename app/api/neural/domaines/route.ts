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
// it.63 — résumé du pré-entraînement massif (plus d'un million de données
// par domaine) — rapport committé par la campagne réelle, null si absent.
import { lireResumeMasse } from "@/lib/gen3/pretrain-masse";
// it.64 — la session million à données uniques (campagne A : 1 005 000
// textes uniques/domaine) devient lisible elle aussi — même honnêteté.
import { lireResumeMillion } from "@/lib/gen3/pretrain-million";
// it.65 — le système d'amélioration continue (générateur de datasets +
// campagne 5M) devient lisible — niveau requis C1-C5 rapporté tel quel.
import { lireResumeContinue } from "@/lib/gen3/amelioration-continue";

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
        // it.63 — pré-entraînement massif (honnête : null si la campagne
        // n'a pas committé de rapport — aucune métrique inventée).
        preentrainementMasse: lireResumeMasse(),
        // it.64 — session million à données uniques (campagne A, le critère
        // propriétaire « > 1 million de données par domaine ») — même
        // honnêteté : null si le rapport n'est pas committé.
        preentrainementMillion: lireResumeMillion(),
        // it.65 — amélioration continue : générateur de datasets + campagne
        // 5M + niveau requis C1-C5 (honnête : null si non committé, un
        // critère non atteint est affiché comme tel).
        ameliorationContinue: lireResumeContinue(),
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
