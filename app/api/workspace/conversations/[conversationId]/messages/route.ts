import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { runConversationTurn } from "@/lib/domain/conversations/engine";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ conversationId: string }> };

const AttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  path: z.string().trim().max(400).optional(),
  url: z.string().trim().max(2000).optional(),
  contentType: z.string().trim().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().max(200 * 1024 * 1024).optional(),
});

const ConnectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Slug de connecteur invalide.");

const BodySchema = z.object({
  message: z.string().trim().min(1).max(20000),
  attachments: z.array(AttachmentSchema).max(8).optional(),
  projectId: z.string().trim().min(1).max(128).optional(),
  provider: z.string().trim().max(60).optional(),
  model: z.string().trim().max(200).optional(),
  connectors: z.array(ConnectorSchema).max(8).optional(),
  authorizationMode: z.enum(["always_ask", "ask_if_needed", "auto_allow"]).optional(),
});

/**
 * Envoie un message dans une conversation : le moteur décide d'une réponse
 * directe, d'une génération d'image ou d'un plan d'exécution (timeline,
 * outils réels, validations humaines, artefacts versionnés).
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await params;

    const limit = await rateLimitDistributed(`ws-msg:${user.uid}:${clientIp(request)}`, {
      limit: 40,
      windowMs: 5 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de messages envoyés. Réessayez dans un instant." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } },
      );
    }

    const body = BodySchema.parse(await request.json());
    const result = await runConversationTurn({
      userId: user.uid,
      conversationId,
      message: body.message,
      attachments: body.attachments,
      projectId: body.projectId,
      provider: body.provider,
      model: body.model,
      connectors: body.connectors,
      authorizationMode: body.authorizationMode,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Le message n'a pas pu être traité."), { status: errorStatus(error, 400) });
  }
}
