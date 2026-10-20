import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";

import { cycleEnCours, executerCycleAuto } from "@/lib/entrainement-auto/boucle";
import { lireEtatAuto } from "@/lib/entrainement-auto/etat";
import { plafondsAuto } from "@/lib/entrainement-auto/plafonds";
import { hubIntegrationStatus } from "@/lib/training/hub";

/**
 * AUTO-APPRENTISSAGE — la connexion hubs (Hugging Face + Kaggle) ↔ IA Gen3.
 *
 * GET  /api/ia/auto-apprentissage — état persistant (cycles, cumuls,
 *      dernier rapport, historique) + intégrations hubs + plafonds actifs.
 * POST /api/ia/auto-apprentissage — déclenche UN cycle complet à la demande
 *      (découverte → choix → ingestion → entraînement réel → persistance).
 *      Refus poli 409 si un cycle tourne déjà (single-flight).
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
    return NextResponse.json(
      {
        etat,
        cycleEnCours: cycleEnCours(),
        integrations: hubIntegrationStatus(),
        plafonds: plafondsAuto(),
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
