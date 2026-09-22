import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { clientIp } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { checkGenQuota, genIsolationGuarantees, runGenTurn } from "@/lib/gen/chat";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * API du chat « gen » (page d'accueil) — SURFACE ISOLÉE.
 *
 * Voir lib/gen/chat.ts pour les garanties : pas d'AgentRuntime, pas
 * d'outils d'agent, connecteurs en lecture stricte uniquement, collections
 * dédiées, quotas Redis distribués.
 */
const MessageSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  conversationId: z.string().trim().min(8).max(128).optional(),
  selectedConnectors: z.array(
    z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,64}$/, "connecteur invalide"),
  ).max(10).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Auth facultative : visiteur = réponses ; connecté = + connecteurs lecture.
    let userId: string | undefined;
    try {
      const user = await requireUser(request);
      userId = user.uid;
    } catch {
      userId = undefined;
    }

    const quota = await checkGenQuota({ userId, ip: clientIp(request) });
    if (!quota.allowed) {
      return NextResponse.json(
        { error: "Vous avez atteint la limite de messages du chat d'accueil. Réessayez dans quelques minutes." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(quota.retryAfterMs / 1000))) } },
      );
    }

    const parsed = MessageSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "Message invalide (1 à 2000 caractères)." }, { status: 400 });
    }

    const result = await runGenTurn({
      userId,
      message: parsed.data.message,
      conversationId: parsed.data.conversationId,
      selectedConnectors: parsed.data.selectedConnectors,
    });

    return NextResponse.json({
      reply: result.reply,
      conversationId: result.conversationId,
      connectorUsed: result.connectorUsed,
      authenticated: Boolean(userId),
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Gen est momentanément indisponible."), { status: errorStatus(error) });
  }
}
