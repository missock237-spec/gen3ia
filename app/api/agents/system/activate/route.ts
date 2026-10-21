import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { timingSafeStringEqual } from "@/lib/security/timing-safe";
import { activateAgentSystemForUser } from "@/lib/agents/system-activation";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * POST /api/agents/system/activate — ACTIVATION INTERNE DU SYSTÈME AGENT
 * (demande utilisateur n°5).
 *
 * Appelé par le MOTEUR IA (jamais par un utilisateur) quand, DANS LE CHAT,
 * l'utilisateur demande une assistance nécessitant des sous-agents et que
 * l'IA décide d'activer le système agent :
 *
 *   utilisateur (chat) → l'IA décide → moteur → CETTE ROUTE (secret serveur)
 *   → lib/agents/system-activation.activateAgentSystemForUser()
 *   → sous-agents navigateur RÉELS créés → ils assistent l'agent navigateur.
 *
 * AUTHENTIFICATION SYSTÈME (pas utilisateur) : bearer `AGENTS_SYSTEM_SECRET`
 * (secret serveur interne, même contrat que CRON_SECRET pour les routes cron).
 *  - secret absent de l'environnement → 503 (le chemin interne n'est pas
 *    configuré : réponse HONNÊTE, jamais de faux succès) ;
 *  - bearer manquant/erroné → 401 (comparaison à temps constant) ;
 *  - corps invalide → 400 ;
 *  - succès → 200 { activated, subAgents[], requestId } (idempotent : une
 *    seconde activation ne duplique RIEN — reason "already_active").
 *
 * Les routes utilisateur de gestion d'agents restent FERMÉES (403 « réservé
 * au système IA » via requireAgentSystemAccess) — c'est le SEUL chemin HTTP
 * d'activation, à côté de l'appel in-process du service par le moteur.
 */

export const dynamic = "force-dynamic";

const ActivateSchema = z.object({
  /** Utilisateur DEMANDEUR (propriétaire des sous-agents créés). */
  userId: z.string().trim().min(6).max(128).regex(/^[A-Za-z0-9:_@.-]+$/, "uid invalide"),
  /** Motif énoncé par l'utilisateur (contexte de la décision de l'IA). */
  demande: z.string().trim().max(2000).optional(),
  /** Origine de l'appel (traçabilité). */
  source: z.enum(["chat", "api-interne"]).default("chat"),
});

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.AGENTS_SYSTEM_SECRET?.trim();
  if (!secret) return false;
  const authorization = request.headers.get("authorization") ?? "";
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();

  // Secret serveur non configuré : 503 honnête (aucune activation simulée).
  if (!process.env.AGENTS_SYSTEM_SECRET?.trim()) {
    return NextResponse.json(
      { error: "Activation du système agent non configurée (AGENTS_SYSTEM_SECRET absent).", code: "PROVIDER_UNAVAILABLE", requestId },
      { status: 503, headers: { "x-request-id": requestId } },
    );
  }
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Secret d'activation interne manquant ou invalide.", code: "AUTH_REQUIRED", requestId },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }

  try {
    const parsed = ActivateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Corps d'activation invalide (userId requis ; demande ≤ 2000 car.).", issues: parsed.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const result = await activateAgentSystemForUser({
      userId: parsed.data.userId,
      ...(parsed.data.demande ? { demande: parsed.data.demande } : {}),
      source: parsed.data.source,
    });
    return NextResponse.json(
      { ...result, requestId },
      { status: 200, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Activation du système agent impossible", requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
