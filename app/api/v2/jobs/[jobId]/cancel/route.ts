import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { captureServerException } from "@/lib/observability/sentry";
import { errorStatus } from "@/lib/security/http-errors";
import { creerGestionnaireJobs } from "@/lib/genapi/jobs";

/** Annulation d'une tâche (mission PHASE 5-6) — propriétaire uniquement. */
const globalJobs = globalThis as typeof globalThis & { __gen3iaGenapiGestionnaireJobs?: ReturnType<typeof creerGestionnaireJobs> };

function gestionnaire() {
  if (!globalJobs.__gen3iaGenapiGestionnaireJobs) globalJobs.__gen3iaGenapiGestionnaireJobs = creerGestionnaireJobs();
  return globalJobs.__gen3iaGenapiGestionnaireJobs;
}

export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { jobId } = await ctx.params;
    const job = gestionnaire().statut(jobId);
    if (!job) return NextResponse.json({ error: { code: "job-inconnu", message: "aucune tâche avec cet identifiant" } }, { status: 404 });
    if (job.proprietaireId !== token.uid) return NextResponse.json({ error: { code: "acces-refuse", message: "cette tâche ne vous appartient pas" } }, { status: 403 });
    const annule = gestionnaire().annuler(jobId, token.uid);
    if (!annule) {
      return NextResponse.json({ error: { code: "annulation-impossible", message: `état « ${job.etat} » : seules les tâches queued/processing sont annulables` } }, { status: 409 });
    }
    return NextResponse.json({ reference: job.reference, etat: "cancelled" }, { status: 200 });
  } catch (erreur) {
    captureServerException(erreur);
    return NextResponse.json({ error: { code: "erreur-interne", message: erreur instanceof Error ? erreur.message : "erreur inconnue" } }, { status: errorStatus(erreur) });
  }
}
