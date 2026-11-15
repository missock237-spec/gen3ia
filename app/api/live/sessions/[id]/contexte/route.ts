import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { assertLiveSessionOwner, recordLiveObservation } from "@/lib/live/repository";
import { generate } from "@/lib/ai/router";
import { conditionnerRequeteRPIA, graineTourChat } from "@/lib/agents/conditionnement-rpia";

/**
 * POST /api/live/sessions/{id}/contexte — CONTEXTE TEXTUEL DE PAGE pour le
 * live (plan d'amélioration C-P0 : « l'agent lit une page et commente »).
 *
 * HONNÊTETÉ (doctrine Task 150 + vision-decider) : le moteur neural Gen3
 * n'interprète PAS les pixels — la perception structurelle des frames
 * (route /frames) mesure dimensions/poids/empreintes sans inventer de
 * contenu. Ce qui est HONNÊTEMENT possible et demandé : l'utilisateur PARTAGE
 * le texte d'une page (même contrat de confidentialité que l'extension
 * navigateur : sur action explicite, jamais en arrière-plan) et l'agent live
 * le commente sur le canal vocal.
 *
 * Le contexte est enregistré comme observation live (journal de session) et
 * la narration Gen3 — modulée par la résonance RPIA du texte (même pont
 * symbolique que le chat) — est retournée pour synthèse vocale côté client.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const ContexteSchema = z.object({
  titre: z.string().trim().min(1).max(300),
  extrait: z.string().trim().min(1).max(12_000),
  source: z.enum(["page-courante", "selection-utilisateur"]).default("page-courante"),
  consensualite: z.literal(true, {
    message: "Le partage de contexte doit être explicite (consensualite: true).",
  }),
});

type ContexteRoute = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: ContexteRoute) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const utilisateur = await verifyFirebaseAuth(request);
    const { id } = await context.params;
    await assertLiveSessionOwner(id, utilisateur.uid);

    const corps = ContexteSchema.safeParse(await request.json());
    if (!corps.success) {
      return NextResponse.json(
        { error: "Corps invalide.", details: corps.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const limite = await enforceRateLimit(`live-contexte:${utilisateur.uid}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limite.allowed) {
      return NextResponse.json(
        { error: "Limite de contexte atteinte (20 / minute). Réessayez shortly.", requestId },
        { status: 429, headers: { "x-request-id": requestId, "retry-after": String(Math.ceil(limite.retryAfterMs / 1000)) } },
      );
    }

    const { titre, extrait, source } = corps.data;
    const texteRequete = `Commente cette page pour l'utilisateur en live. Titre : ${titre}. Contenu partagé : ${extrait.slice(0, 4000)}`;

    // Modulation RPIA — le même pont symbolique que le chat (système nerveux
    // unique) : le profil de résonance du texte partagé pilote la narration.
    const conditionnement = conditionnerRequeteRPIA(texteRequete, graineTourChat(utilisateur.uid, texteRequete));
    const messages = conditionnement
      ? [
          { role: "system" as const, content: conditionnement.directives.join("\n") },
          { role: "user" as const, content: texteRequete },
        ]
      : [{ role: "user" as const, content: texteRequete }];

    const reponse = await generate({
      task: "chat",
      messages,
      maxTokens: 1200,
      metadata: { purpose: "live-page-context-narration" },
    });

    await recordLiveObservation(id, {
      deviceId: "contexte-page",
      decisionMessage: `Contexte partagé (${source}) : « ${titre} » — narration générée.`,
      done: false,
    });

    return NextResponse.json(
      {
        narration: reponse.text,
        rpia: { telemetrie: conditionnement?.telemetrie ?? null },
        usage: reponse.usage,
        requestId,
      },
      { status: 200, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), {
      status: errorStatus(error, 500),
      headers: { "x-request-id": requestId },
    });
  }
}
