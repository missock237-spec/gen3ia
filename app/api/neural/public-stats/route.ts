import { NextResponse } from "next/server";

import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * STATISTIQUES PUBLIQUES du moteur neuronal — métriques ANONYMES du cerveau
 * collectif (compteurs structurels uniquement : neurones, synapses, poids
 * moyen, cycles, santé). Aucune donnée utilisateur, aucun prompt, aucune
 * clé : la vitrine publique affiche l'état RÉEL du moteur qui propulse la
 * plateforme.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runtime = getNeuralRuntime();
    const stats = runtime.reseau.getStats();

    return NextResponse.json(
      {
        moteur: "gen3-snn-v1",
        cerveau: {
          nbNeurones: stats.nbNeurones,
          nbSynapses: stats.nbSynapses,
          poidsMoyen: Number(stats.poidsMoyen.toFixed(3)),
          histogramme: stats.histogramme,
        },
        sante: {
          cyclesTotaux: runtime.noyau.metriquesSante.cyclesTotaux,
          energieMoyenne: Number(runtime.noyau.metriquesSante.energieMoyenne.toFixed(3)),
          indiceHomeostasie: runtime.noyau.metriquesSante.indiceHomeostasie,
          mode: runtime.noyau.metriquesSante.modeActuel,
        },
        iaExterne: "aucune — moteur 100 % local",
      },
      { headers: { "cache-control": "public, max-age=30, stale-while-revalidate=60" } },
    );
  } catch {
    // Vitrine publique : jamais d'erreur visible — le fallback honnête
    // déclare simplement le moteur sans chiffres.
    return NextResponse.json(
      { moteur: "gen3-snn-v1", cerveau: null, iaExterne: "aucune — moteur 100 % local" },
      { status: 200, headers: { "cache-control": "public, max-age=30" } },
    );
  }
}
