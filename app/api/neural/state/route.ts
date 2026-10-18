import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";

import { getNeuralRuntime } from "@/lib/neural/runtime";
import { getDernierJob } from "@/lib/neural/training/job";

/**
 * ÉTAT DU SYSTÈME NEURONAL GEN3 — instantané complet, données 100 % réelles :
 * configuration du cerveau, statistiques synaptiques, santé du noyau,
 * pools résonants enregistrés, catalogue du Tool OS, historique
 * d'entraînement et dernier job d'entraînement.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);

    const runtime = getNeuralRuntime();
    const stats = runtime.reseau.getStats();

    return NextResponse.json({
      moteurNeuralActif: true,
      modele: "gen3-snn-v1",
      creeLe: runtime.creeLe,
      cerveau: {
        nbNeurones: stats.nbNeurones,
        nbSynapses: stats.nbSynapses,
        poids: {
          moyen: stats.poidsMoyen,
          min: stats.poidsMin,
          max: stats.poidsMax,
        },
      },
      sante: { ...runtime.noyau.metriquesSante },
      horlogeVirtuelle: runtime.noyau.time,
      poolsSortie: Object.fromEntries(runtime.espace.outputPools),
      poolsEntree: Object.fromEntries(runtime.espace.inputPools),
      outils: Array.from(runtime.toolOs.registreOutils.entries()).map(
        ([nom, outil]) => ({
          nom,
          description: outil.description,
          utilisations: outil.utilisations,
          succesHistorique: outil.succesHistorique,
        }),
      ),
      competences: Array.from(
        runtime.moteurCompetences.catalogueSkills.entries(),
      ).map(([nom, meta]) => ({ nom, ...meta })),
      historiqueEntrainement: runtime.historiqueEntrainement,
      dernierJobEntrainement: getDernierJob(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}
