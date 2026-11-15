import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";

import { lireEtatAuto } from "@/lib/entrainement-auto/etat";
import { blocMaitriseDe, CATALOGUE_MAITRISE, maitriseComplete } from "@/lib/entrainement-auto/maitrise";

/**
 * RAPPORT D'ÉVALUATION COMPLET — « teste-le pour évaluation à grande
 * échelle » (demande utilisateur).
 *
 * Contrairement au GET principal (qui n'expose que la DERNIÈRE évaluation
 * par domaine), ce rapport liste l'HISTORIQUE COMPLET des évaluations
 * persistées (10 dernières par domaine, les plus récentes d'abord) avec
 * pour chacune : date, précision mesurée, unités évaluées, validité
 * statistique. Aucune métrique fabriquée : les chiffres viennent de
 * l'état persisté par la boucle d'auto-apprentissage (rétention cortex
 * pour le langage, accuracyTest SNN sur données tenues à l'écart pour
 * l'intention).
 *
 * Honnêteté : les évaluations `valide: false` sont sous-seuil d'unités
 * (non comptables pour la maîtrise) — elles sont conservées et signalées,
 * jamais maquillées. Le JSON est conçu pour être EXPORTABLE (copie
 * intégrale = rapport d'évaluation).
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
    const bloc = blocMaitriseDe(etat);
    const genereA = new Date().toISOString();

    const domaines = CATALOGUE_MAITRISE.map((domaine) => {
      const etatDomaine = bloc.domaines[domaine.id];
      const evaluations = etatDomaine?.dernieresEvaluations ?? [];
      const valides = evaluations.filter((e) => e.valide);
      const dernier = evaluations[0] ?? null;
      const meilleur = evaluations.reduce<number | null>(
        (max, e) => (max === null || e.accuracy > max ? e.accuracy : max),
        null,
      );
      const tendance =
        evaluations.length >= 2 && dernier
          ? Number.parseFloat((dernier.accuracy - evaluations[evaluations.length - 1].accuracy).toFixed(4))
          : null;
      return {
        id: domaine.id,
        label: domaine.label,
        objectif: domaine.objectif,
        seuil: domaine.seuil,
        minUnites: domaine.minUnites,
        maitriseA: etatDomaine?.maitriseA ?? null,
        datasetsIngeres: etatDomaine?.datasetsIngerees.length ?? 0,
        unitesIngerees:
          domaine.objectif === "langage"
            ? etatDomaine?.pairesIngestees ?? 0
            : etatDomaine?.echantillonsIngestes ?? 0,
        passesConsicutifs: etatDomaine?.passesConsicutifs ?? 0,
        resume: {
          evaluationsConsignees: evaluations.length,
          evaluationsValides: valides.length,
          derniereAccuracy: dernier?.accuracy ?? null,
          derniereDate: dernier?.dateA ?? null,
          meilleureAccuracy: meilleur,
          /** Δ entre la dernière et la plus ancienne consignée (>0 = progrès). */
          tendance,
        },
        evaluations,
      };
    });

    const domainesMaitrises = domaines.filter((d) => d.maitriseA !== null).length;

    return NextResponse.json(
      {
        rapport: {
          genereA,
          protocole:
            "Précision mesurée sur des données tenues À L'ÉCART de l'entraînement (rétention cortex pour le langage, accuracyTest SNN pour l'intention). Une évaluation n'est comptable que si elle porte sur au moins le minimum d'unités du domaine (valide=true).",
          maitriseComplete: maitriseComplete(etat),
          domainesMaitrises,
          domainesTotal: CATALOGUE_MAITRISE.length,
          evaluationsTotales: bloc.evaluationsTotales,
          cyclesSansProgres: bloc.cyclesSansProgres,
        },
        domaines,
        requestId,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Rapport d'évaluation indisponible."), requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}
