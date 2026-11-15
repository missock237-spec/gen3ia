import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

import { getNeuralRuntime, sauvegarderCerveauRuntime } from "@/lib/neural/runtime";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";

/**
 * ÉVOLUTION CONTINUE DE L'IA — télémétrie + consolidation pilotée.
 *
 * GET  /api/neural/evolve : métriques RÉELLES d'évolution du cerveau
 *      (échanges observés, consolidés, cycles de consolidation, dernière
 *      consolidation) + état du cortex — alimente la page Cerveau.
 * POST /api/neural/evolve : force un cycle de consolidation immédiat
 *      (les échanges réussis observés deviennent des connaissances
 *      durables) puis sauvegarde le cerveau persisté. Authentifié,
 *      débit limité, audité — l'évolution n'est jamais silencieuse.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`neural-evolve:${user.uid}`, { limit: 60, windowMs: 60_000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de requêtes : réessayez dans un instant." },
        { status: 429 },
      );
    }
    const runtime = getNeuralRuntime();
    return NextResponse.json({
      moteur: "gen3-snn-v1",
      evolution: runtime.evolution.metriques(),
      cortex: {
        paires: runtime.cortex.nbPaires,
        pairesPersonnalisees: runtime.cortex.compterPersonnalisees(),
        vocabulaire: runtime.cortex.tailleVocabulaire,
        themes: runtime.cortex.themes().length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Métriques d'évolution indisponibles." },
      { status: errorStatus(error, 400) },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // Une consolidation écrit dans le cerveau persisté : débit serré.
    const limit = await enforceRateLimit(`neural-evolve:${user.uid}`, { limit: 6, windowMs: 60_000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Consolidations trop fréquentes : le cerveau vient d'être consolidé." },
        { status: 429 },
      );
    }

    const runtime = getNeuralRuntime();
    const resultat = runtime.evolution.consolider();
    let sauvegarde = false;
    if (resultat.enseignees > 0 || resultat.dejaConnues > 0) {
      sauvegarde = await sauvegarderCerveauRuntime().catch(() => false);
    }

    void recordTrainingAudit({
      uid: user.uid,
      action: "neural.evolution.consolidated",
      entityType: "neural",
      entityId: "cortex-langagier",
      ip: ipFromRequest(request),
      details: {
        enseignees: resultat.enseignees,
        dejaConnues: resultat.dejaConnues,
        ecarts: resultat.ecarts,
        sauvegarde,
      },
    }).catch(() => undefined);

    return NextResponse.json({
      consolidation: {
        enseignees: resultat.enseignees,
        dejaConnues: resultat.dejaConnues,
        ecarts: resultat.ecarts,
        pairesApprises: resultat.stats?.pairesAjoutees ?? 0,
      },
      evolution: runtime.evolution.metriques(),
      sauvegarde,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Consolidation impossible." },
      { status: errorStatus(error, 400) },
    );
  }
}
