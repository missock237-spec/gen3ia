import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { runWithApiTokenBilling } from "@/lib/billing/api-usage";
// Garde de charge : l'API publique partage le plafond de tours IA simultanés
// du process (429 honnête + Retry-After en saturation).
import { acquiertourIa, RETRY_AFTER_SECONDES } from "@/lib/security/concurrency";
import { generate } from "@/lib/ai/router";
import { conditionnerRequeteRPIA, graineTourChat } from "@/lib/agents/conditionnement-rpia";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * POST /api/v1/chat — L'API fonctionne au PORTEFEUILLE (décision utilisateur,
 * 2026-10-24) : PAS d'abonnement. Chaque appel est authentifié par une clé
 * développeur `g3a_`, limité en débit, et débité au RÉEL (tokens mesurés par
 * le moteur — 1,00 €/1M entrant, 1,50 €/1M sortant, XAF à parité fixe) via le
 * cycle réservation → exécution → règlement. En mode libre (facturation non
 * armée), l'appel répond sans débit — le mode libre est le défaut fail-safe.
 *
 * Le chat v1 passe par le MÊME moteur neuronal que la plateforme (router →
 * moteur Gen3) et applique la MODULATION RPIA (pont symbolique) à la requête :
 * le profil de résonance mesuré pilote les directives de réponse — le système
 * nerveux complet, pas un wrapper décorrélé.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const CorpsChat = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1).max(32_000),
      }),
    )
    .min(1, "Au moins un message requis.")
    .max(40, "40 messages maximum par appel."),
  model: z.string().max(120).optional(),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const porte = await franchirPorteV1(request, "chat");

    const corps = CorpsChat.safeParse(await request.json());
    if (!corps.success) {
      return NextResponse.json(
        { error: "Corps invalide : { messages: [{role, content}], model? }.", details: corps.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId, ...porte.enTetesLimite } },
      );
    }

    const dernierUtilisateur = [...corps.data.messages].reverse().find((m) => m.role === "user");
    const texteRequete = dernierUtilisateur?.content ?? "";

    // MODULATION RPIA — le profil de résonance MESURÉ de la requête pilote
    // les directives (structure, densité, ambiguïté). Fail-soft : sans couche,
    // l'appel répond sans modulation (jamais bloqué).
    const conditionnement = texteRequete
      ? conditionnerRequeteRPIA(texteRequete, graineTourChat(porte.identite.userId, texteRequete))
      : null;
    const directives = conditionnement?.directives ?? [];
    const messages = directives.length
      ? [
          { role: "system" as const, content: directives.join("\n") },
          ...corps.data.messages,
        ]
      : corps.data.messages;

    // Garde de concurrence : admission de l'appel coûteux.
    const jeton = acquiertourIa("v1-chat");
    if (!jeton) {
      return NextResponse.json(
        { error: "La plateforme est à pleine capacité. Réessayez dans quelques secondes.", requestId },
        { status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDES), "x-request-id": requestId } },
      );
    }

    try {
      const { result, usage } = await runWithApiTokenBilling({
        userId: porte.identite.userId,
        apiKeyId: porte.identite.projectId ?? "sans-projet",
        apiKeyPrefix: "g3a_",
        endpoint: "POST /api/v1/chat",
        objective: texteRequete.slice(0, 400),
        executionId: requestId,
        fn: () =>
          generate({
            task: "chat",
            messages,
            maxTokens: 4096,
            metadata: { purpose: "api-v1-chat" },
          }),
        measure: (reponse) => ({
          inputTokens: reponse.usage.inputTokens,
          outputTokens: reponse.usage.outputTokens,
        }),
      });

    return NextResponse.json(
      {
        answer: result.text,
        model: { provider: result.provider, model: result.model },
        usage: result.usage,
        billing: {
          billed: usage.billed,
          billingEnabled: usage.billingEnabled,
          measuredTokens: usage.measuredTokens,
          charge: usage.charge,
          debitedMinor: usage.debitedMinor,
          currency: usage.currency,
          measurementNote: usage.measurementNote,
        },
        rpia: conditionnement
          ? { telemetrie: conditionnement.telemetrie, directives: conditionnement.directives.length }
          : { telemetrie: null, directives: 0 },
        requestId,
      },
      { status: 200, headers: { "x-request-id": requestId, ...porte.enTetesLimite } },
    );
    } finally {
      jeton.release();
    }
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue.", requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
