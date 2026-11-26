import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { captureServerException } from "@/lib/observability/sentry";
import { errorStatus } from "@/lib/security/http-errors";
import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { applicationsDeProprietaire, estServiceGenapi, lireApplicationGenapi } from "@/lib/genapi/services";
import { appelerServiceGenapi } from "@/lib/genapi/adaptateurs";
import { ErreurGateway, traverserGateway, versionDepuisChemin } from "@/lib/genapi/gateway";

/**
 * API REST PUBLIQUE v2 — genAPI (mission PHASE 8-2). Cœur REST de la
 * passerelle : auth clés `g3a_` (porte v1 conservée), sélection de
 * l'application par header `x-gen3ia-app-id`, puis passerelle centrale
 * (permissions par service, validation, quota, journal, timeout) puis
 * ADAPTATEUR réel vers le Core Gen3. Aucune logique décisionnelle ici.
 */
const ChatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(20_000) }))
    .min(1)
    .max(40),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  /** En-tête Idempotency-Key : facturation idempotente (PHASE 6-10). */
  idempotenceKey: z.string().min(8).max(128).optional(),
});

function refuserCorps(message: string, statut = 400) {
  return NextResponse.json({ error: { code: "requete-invalide", message } }, { status: statut });
}

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const appId = request.headers.get("x-gen3ia-app-id")?.trim();
    if (!appId) return refuserCorps("header x-gen3ia-app-id requis (l'application développeur ciblée)");
    const app = lireApplicationGenapi(appId);
    if (!app) return refuserCorps("application inconnue — créez-la via le portail développeur (PHASE 7)", 404);
    if (app.proprietaireId !== token.uid) return refuserCorps("cette application ne vous appartient pas", 403);

    const version = versionDepuisChemin(new URL(request.url).pathname);
    await franchirPorteV1(request, `v2:chat`);
    const corps = await request.json().catch(() => null);
    const parse = ChatSchema.safeParse(corps);
    if (!parse.success) {
      return refuserCorps(`charge invalide : ${parse.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const estTest = app.environnement === "test";

    const resultat = await traverserGateway<z.infer<typeof ChatSchema>, Awaited<ReturnType<typeof appelerServiceGenapi>>>(
      {
        version,
        service: "chat",
        application: app,
        environnement: estTest ? "test" : "production",
        schema: ChatSchema,
        charge: parse.data,
        timeoutMs: 120_000,
      },
      async (charge) => {
        const reponse = await appelerServiceGenapi("chat", { messages: charge.messages, temperature: charge.temperature, maxTokens: charge.maxTokens });
        return reponse;
      },
    );

    return NextResponse.json({ requestId: resultat.requestId, version: resultat.version, data: resultat.data }, { status: 200, headers: { "x-gen3ia-request-id": resultat.requestId } });
  } catch (erreur) {
    if (erreur instanceof ErrorAccesV1) {
      return NextResponse.json({ error: { code: "acces-refuse", message: erreur.message } }, { status: erreur.statut, headers: erreur.enTetes });
    }
    if (erreur instanceof ErreurGateway) {
      return NextResponse.json(erreur.corps(), { status: erreur.statut, headers: erreur.enTetes });
    }
    captureServerException(erreur);
    return NextResponse.json({ error: { code: "erreur-interne", message: erreur instanceof Error ? erreur.message : "erreur inconnue" } }, { status: errorStatus(erreur) });
  }
}

/** GET /api/v2/chat : catalogue des services genAPI (PHASE 4 discovery). */
export async function GET(request: Request) {
  const token = await verifyFirebaseAuth(request);
  void estServiceGenapi; // (conservé : validation des noms côté portail)
  const apps = applicationsDeProprietaire(token.uid);
  return NextResponse.json({
    services: ["chat", "reasoning", "research", "vision", "audio", "video", "agents", "automation", "embeddings", "training"],
    versions: ["v1", "v2"],
    applications: apps.map((a) => ({ id: a.id, nom: a.nom, environnement: a.environnement, servicesAutorises: a.servicesAutorises, revoquee: a.revoquee })),
  });
}
