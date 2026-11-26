import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { captureServerException } from "@/lib/observability/sentry";
import { errorStatus } from "@/lib/security/http-errors";
import { creerGestionnaireJobs } from "@/lib/genapi/jobs";

/**
 * Statut d'une tâche (mission PHASE 5-5) et ANNUULATION (PHASE 5-6).
 * GET : consulte l'état ; POST /cancel : annule (propriétaire uniquement).
 */
const globalJobs = globalThis as typeof globalThis & { __gen3iaGenapiGestionnaireJobs?: ReturnType<typeof creerGestionnaireJobs> };

function gestionnaire() {
  if (!globalJobs.__gen3iaGenapiGestionnaireJobs) globalJobs.__gen3iaGenapiGestionnaireJobs = creerGestionnaireJobs();
  return globalJobs.__gen3iaGenapiGestionnaireJobs;
}

export async function GET(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { jobId } = await ctx.params;
    const job = gestionnaire().statut(jobId);
    if (!job) return NextResponse.json({ error: { code: "job-inconnu", message: "aucune tâche avec cet identifiant" } }, { status: 404 });
    if (job.proprietaireId !== token.uid) return NextResponse.json({ error: { code: "acces-refuse", message: "cette tâche ne vous appartient pas" } }, { status: 403 });
    return NextResponse.json({ reference: job.reference, service: job.service, etat: job.etat, resultat: job.resultat ?? null, cree: job.cree, maj: job.maj });
  } catch (erreur) {
    captureServerException(erreur);
    return NextResponse.json({ error: { code: "erreur-interne", message: erreur instanceof Error ? erreur.message : "erreur inconnue" } }, { status: errorStatus(erreur) });
  }
}
