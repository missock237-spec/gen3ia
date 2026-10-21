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
        langage: {
          paires: runtime.cortex.nbPaires,
          vocabulaire: runtime.cortex.tailleVocabulaire,
          themes: runtime.cortex.themes().length,
          pairesPersonnalisees: runtime.cortex.compterPersonnalisees(),
        },
        evolution: {
          echangesObserves: runtime.evolution.metriques().echangesObserves,
          echangesConsolides: runtime.evolution.metriques().echangesConsolides,
          cyclesConsolidation: runtime.evolution.metriques().cyclesConsolidation,
          apprentissageContinu: true,
        },
        entraînementUtilisateurs: {
          studio: "Gen entraîne les modèles fournis par les utilisateurs",
          moteurNatif: "gen3-native (CPU local, apprentissage réel)",
        },
        cortexV2: blocCortexV2(runtime),
        autoApprentissage: await blocAutoApprentissagePublic(),
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

/** Construit le bloc public Cortex v2 (données réelles du runtime). */
function blocCortexV2(runtime: ReturnType<typeof getNeuralRuntime>) {
  if (!runtime.cortexV2) return null;
  const etat = runtime.cortexV2.etatPourApi();
  return {
    colonnes: etat.cortex.colonnes,
    aretes: etat.cortex.aretes,
    champNeuronesAdressables: etat.champ.taille,
    neuronesTotaux: etat.cortex.colonnes + etat.champ.taille + 100,
    vitesse: {
      msCycle: etat.cortex.msCycleEma,
      cyclesParSeconde: etat.cortex.cyclesParSeconde,
    },
    champ: {
      amplitudeMoyenne:
        Math.round(etat.champ.amplitudeMoyenne * 1000) / 1000,
      fractionActive:
        Math.round(etat.champ.fractionActive * 1000) / 1000,
      erreurEchantillon:
        Math.round(etat.champ.erreurEchantillon * 10000) / 10000,
    },
    consolidation: etat.consolidation,
  };
}

/**
 * BLOC PUBLIC AUTO-APPRENTISSAGE — l'état RÉEL de la boucle autonome
 * (régime maîtrise : entraînement continu depuis Hugging Face + Kaggle).
 * Métriques anonymes et honnêtes issues de l'état persisté ; en cas
 * d'indisponibilité, le bloc le dit (jamais de donnée fabriquée).
 */
async function blocAutoApprentissagePublic() {
  try {
    const { lireEtatAuto } = await import("@/lib/entrainement-auto/etat");
    const { CATALOGUE_MAITRISE, domainesMaitrises, maitriseComplete } = await import(
      "@/lib/entrainement-auto/maitrise"
    );
    const { cycleEnCours } = await import("@/lib/entrainement-auto/boucle");
    const etat = await lireEtatAuto();
    const bloc = etat.maitrise;
    return {
      regime: etat.regime,
      actif: true,
      cycleEnCours: cycleEnCours(),
      cyclesExecutes: etat.cyclesExecutes,
      pairesCumulees: etat.pairesCumulees,
      echantillonsCumules: etat.echantillonsCumules,
      datasetsIngestes: etat.datasetsIngestes.length,
      hubs: { huggingface: true, kaggle: Boolean(process.env.KAGGLE_API_TOKEN) },
      maitrise: {
        complete: maitriseComplete(etat),
        atteinteA: bloc?.atteinteA ?? null,
        evaluations: bloc?.evaluationsTotales ?? 0,
        cyclesSansProgres: bloc?.cyclesSansProgres ?? 0,
        domainesMaitrises: domainesMaitrises(bloc),
        domainesTotal: CATALOGUE_MAITRISE.length,
        derniers: CATALOGUE_MAITRISE.slice(0, 12).map((domaine) => {
          const etatDomaine = bloc?.domaines?.[domaine.id];
          const derniere = etatDomaine?.dernieresEvaluations?.[0] ?? null;
          return {
            id: domaine.id,
            maitrise: Boolean(etatDomaine?.maitriseA),
            unites:
              domaine.objectif === "langage"
                ? etatDomaine?.pairesIngestees ?? 0
                : etatDomaine?.echantillonsIngestes ?? 0,
            precision: derniere ? Math.round(derniere.accuracy * 100) : null,
          };
        }),
      },
    };
  } catch {
    return { regime: null, actif: false, note: "État d'auto-apprentissage indisponible." };
  }
}
