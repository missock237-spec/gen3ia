import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";

import { cycleEnCours, executerCycleAuto } from "@/lib/entrainement-auto/boucle";
import { lireEtatAuto } from "@/lib/entrainement-auto/etat";
import { phaseDe } from "@/lib/entrainement-auto/phases";
import { plafondsAuto } from "@/lib/entrainement-auto/plafonds";
import {
  blocMaitriseDe,
  CATALOGUE_MAITRISE,
  domainesMaitrises,
  maitriseComplete,
} from "@/lib/entrainement-auto/maitrise";
import { hubIntegrationStatus } from "@/lib/training/hub";

/**
 * AUTO-APPRENTISSAGE — la connexion hubs (Hugging Face + Kaggle) ↔ IA Gen3,
 * dans le CYCLE DE VIE absorption → autonomie.
 *
 * GET  /api/ia/auto-apprentissage — état persistant (cycles, cumuls,
 *      dernier rapport, historique) + PHASE COURANTE (absorption avec temps
 *      restant / autonomie), BILAN D'AUTONOMIE, intégrations hubs, plafonds.
 * POST /api/ia/auto-apprentissage — déclenche UN cycle complet à la demande
 *      (découverte → choix → ingestion → entraînement réel → persistance).
 *      Refus poli 409 si un cycle tourne déjà (single-flight) ou si la
 *      fenêtre d'absorption est clôturée : l'IA n'apprend plus des datasets,
 *      son évolution passe par ses utilisateurs.
 *
 * La boucle se déclenche DÉJÀ SEULE au lancement du serveur
 * (instrumentation.ts) : cette route est la fenêtre de contrôle honnête
 * (aucune métrique fabriquée) pour l'utilisateur et le dashboard.
 */

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`ia:auto-apprentissage:${user.uid}`, {
      limit: 60,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de consultations : patientez un instant.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const etat = await lireEtatAuto();
    const vue = phaseDe(etat);
    const bloc = blocMaitriseDe(etat);
    return NextResponse.json(
      {
        etat,
        phase: vue.phase,
        regime: vue.regime,
        absorptionCloturee: vue.absorptionCloturee,
        clotureeA: vue.clotureeA,
        restantMs: vue.restantMs,
        cycleEnCours: cycleEnCours(),
        integrations: hubIntegrationStatus(),
        plafonds: plafondsAuto(),
        maitrise: {
          complete: maitriseComplete(etat),
          atteinteA: bloc.atteinteA,
          evaluationsTotales: bloc.evaluationsTotales,
          cyclesSansProgres: bloc.cyclesSansProgres,
          domainesMaitrises: domainesMaitrises(bloc),
          domainesTotal: CATALOGUE_MAITRISE.length,
          domaines: CATALOGUE_MAITRISE.map((domaine) => {
            const etatDomaine = bloc.domaines[domaine.id];
            const unites =
              domaine.objectif === "langage"
                ? etatDomaine?.pairesIngestees ?? 0
                : etatDomaine?.echantillonsIngestes ?? 0;
            const derniere = etatDomaine?.dernieresEvaluations?.[0] ?? null;
            return {
              id: domaine.id,
              label: domaine.label,
              objectif: domaine.objectif,
              maitriseA: etatDomaine?.maitriseA ?? null,
              datasets: etatDomaine?.datasetsIngerees.length ?? 0,
              unites,
              minUnites: domaine.minUnites,
              seuil: domaine.seuil,
              derniereEvaluation: derniere,
            };
          }),
        },
        requestId,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "État d'auto-apprentissage indisponible."), requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    // Un cycle coûte des appels hub + un entraînement SNN : quota strict.
    const limit = await rateLimitDistributed(`ia:auto-apprentissage-cycle:${user.uid}`, {
      limit: 3,
      windowMs: 5 * 60_000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Quota de cycles manuels atteint (3 par 5 minutes).", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const rapport = await executerCycleAuto();
    if (!rapport) {
      return NextResponse.json(
        { error: "Un cycle d'auto-apprentissage est déjà en cours.", requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    if (rapport.statut === "refuse") {
      // Régime fenêtre + phase autonomie : la fenêtre d'absorption est
      // clôturée — l'IA n'apprend plus des datasets. Refus poli, tout
      // porteur de vérité. (En régime maîtrise ce refus ne se produit pas :
      // les hubs restent ouverts jusqu'à maîtrise complète du catalogue.)
      return NextResponse.json(
        { rapport, error: rapport.message, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json(
      { rapport, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Cycle d'auto-apprentissage impossible."), requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}
