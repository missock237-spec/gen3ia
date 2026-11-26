import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { captureServerException } from "@/lib/observability/sentry";
import { errorStatus } from "@/lib/security/http-errors";
import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { lireApplicationGenapi } from "@/lib/genapi/services";
import { appelerServiceGenapi } from "@/lib/genapi/adaptateurs";
import { creerGestionnaireJobs } from "@/lib/genapi/jobs";

/**
 * API REST PUBLIQUE v2 — tâches asynchrones (mission PHASE 5).
 * POST : enfile une opération longue → réponse IMMÉDIATE { job_id }.
 * GET  : liste des jobs de l'application.
 * La reprise après crash est appliquée à chaque appel (mission PHASE 5-7) :
 * aucun job orphelin ne reste « processing ».
 */
const JobSchema = z.object({
  service: z.enum(["chat", "reasoning", "research", "vision", "audio", "video", "agents", "automation", "embeddings", "training"]),
  charge: z.unknown().optional(),
});

const globalJobs = globalThis as typeof globalThis & { __gen3iaGenapiGestionnaireJobs?: ReturnType<typeof creerGestionnaireJobs> };

function gestionnaire() {
  if (!globalJobs.__gen3iaGenapiGestionnaireJobs) globalJobs.__gen3iaGenapiGestionnaireJobs = creerGestionnaireJobs();
  return globalJobs.__gen3iaGenapiGestionnaireJobs;
}

function refuserCorps(message: string, statut = 400) {
  return NextResponse.json({ error: { code: "requete-invalide", message } }, { status: statut });
}

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const appId = request.headers.get("x-gen3ia-app-id")?.trim();
    if (!appId) return refuserCorps("header x-gen3ia-app-id requis");
    const app = lireApplicationGenapi(appId);
    if (!app) return refuserCorps("application inconnue", 404);
    if (app.proprietaireId !== token.uid) return refuserCorps("cette application ne vous appartient pas", 403);
    await franchirPorteV1(request, "v2:jobs");
    const corps = await request.json().catch(() => null);
    const parse = JobSchema.safeParse(corps);
    if (!parse.success) return refuserCorps("charge invalide : service requis parmi les 10 services genAPI");

    // Reprise après crash (mission PHASE 5-7) avant d'enfiler un nouveau job.
    gestionnaire().repriseApresCrash();
    const gestionnaireJobs = gestionnaire();
    const enfile = gestionnaireJobs.creer(parse.data.service, parse.data.charge ?? null, { id: app.id, proprietaireId: token.uid });

    // Exécution en arrière-plan réelle : le travailleur = adaptateur Core.
    void (async () => {
      try {
        await gestionnaireJobs.traiterSuivant(app.id, async (charge) => {
          const r = await appelerServiceGenapi(parse.data.service, charge);
          return r.statut === "ok" ? { ok: true, data: r.data } : { ok: false, erreur: r.raison };
        });
      } catch {
        /* échec déjà enregistré par le gestionnaire */
      }
    })();

    return NextResponse.json({ job_id: enfile.reference, jobId: enfile.jobId, etat: enfile.etat }, { status: 202 });
  } catch (erreur) {
    if (erreur instanceof ErrorAccesV1) {
      return NextResponse.json({ error: { code: "acces-refuse", message: erreur.message } }, { status: erreur.statut, headers: erreur.enTetes });
    }
    captureServerException(erreur);
    return NextResponse.json({ error: { code: "erreur-interne", message: erreur instanceof Error ? erreur.message : "erreur inconnue" } }, { status: errorStatus(erreur) });
  }
}

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const appId = request.headers.get("x-gen3ia-app-id")?.trim();
    if (!appId) return refuserCorps("header x-gen3ia-app-id requis");
    const app = lireApplicationGenapi(appId);
    if (!app) return refuserCorps("application inconnue", 404);
    if (app.proprietaireId !== token.uid) return refuserCorps("cette application ne vous appartient pas", 403);
    gestionnaire().repriseApresCrash();
    return NextResponse.json({ jobs: gestionnaire().liste(app.id).map((j) => ({ reference: j.reference, service: j.service, etat: j.etat, cree: j.cree, maj: j.maj, resultat: j.resultat ?? null })) });
  } catch (erreur) {
    captureServerException(erreur);
    return NextResponse.json({ error: { code: "erreur-interne", message: erreur instanceof Error ? erreur.message : "erreur inconnue" } }, { status: errorStatus(erreur) });
  }
}
