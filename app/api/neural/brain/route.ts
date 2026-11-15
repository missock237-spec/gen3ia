import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";

import { getNeuralRuntime } from "@/lib/neural/runtime";
import { capturerSnapshot } from "@/lib/neural/generation/snapshot";
import { getDernierJob } from "@/lib/neural/training/job";

/**
 * CERVEAU — snapshot VISUALISABLE du réseau réel (constellation synaptique,
 * énergies, histogramme des poids). Données 100 % réelles extraites du
 * cerveau entraîné : la carte affichée par la console V6 est le VRAI réseau.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);

    const runtime = getNeuralRuntime();
    const stats = runtime.reseau.getStats();

    // Snapshot standardisé (mêmes structures que les moteurs de génération).
    const snapshot = capturerSnapshot(
      runtime.reseau,
      "visualisation console",
    );

    return NextResponse.json({
      modele: "gen3-snn-v1",
      creeLe: runtime.creeLe,
      stats: {
        nbNeurones: stats.nbNeurones,
        nbSynapses: stats.nbSynapses,
        poidsMoyen: stats.poidsMoyen,
        poidsMin: stats.poidsMin,
        poidsMax: stats.poidsMax,
        histogramme: stats.histogramme,
      },
      constellation: snapshot.echantillonSynapses,
      energies: snapshot.energies,
      sante: { ...runtime.noyau.metriquesSante },
      pools: Object.fromEntries(runtime.espace.outputPools),
      hippocampe: {
        toursMemorises: runtime.hippocampe.getHistory().length,
        fenetreMax: 10,
      },
      langage: {
        paires: runtime.cortex.nbPaires,
        pairesPersonnalisees: runtime.cortex.compterPersonnalisees(),
        vocabulaire: runtime.cortex.tailleVocabulaire,
        themes: runtime.cortex.themes().length,
      },
      evolution: runtime.evolution.metriques(),
      dernierJobEntrainement: getDernierJob(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}
