import { NextRequest } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { runConversationTurn } from "@/lib/domain/conversations/engine";
import type { ConversationStreamEvent } from "@/lib/domain/conversations/stream-events";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ conversationId: string }> };

const ConnectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Slug de connecteur invalide.");

const AttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  path: z.string().trim().max(400).optional(),
  url: z.string().trim().max(2000).optional(),
  contentType: z.string().trim().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().max(200 * 1024 * 1024).optional(),
});

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
 * Envoie un message en STREAMING : la réponse est un flux NDJSON (un objet
 * événement par ligne) qui restitue le tour en direct — phases de travail,
 * fragments de la réponse, étapes d'outils, cartes de validation, artefacts,
 * état final. La persistance serveur (messages, run, validations, artefacts)
 * est IDENTIQUE à la route classique : un client qui perd le flux retrouve
 * tout au rechargement.
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
      return Response.json(
        { error: "Trop de messages envoyés. Réessayez dans un instant." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } },
      );
    }

    const body = BodySchema.parse(await request.json());

    // Le flux démarre après les vérifications d'accès : les événements
    // arrivent dès que le moteur les émet, sans buffer intermédiaire.
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: ConversationStreamEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // Client déconnecté : on cesse d'émettre ; le moteur continue
            // son tour et la persistance serveur reste autoritaire.
            closed = true;
          }
        };

        try {
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
            onEvent: send,
          });
          // L'événement « done » est émis par le moteur lui-même : le flux
          // se referme proprement ici.
          void result;
          closed = true;
          controller.close();
        } catch (error) {
          if (!closed) {
            send({
              type: "error",
              message: error instanceof Error ? error.message : "Le message n'a pas pu être traité.",
            });
          }
          closed = true;
          try {
            controller.close();
          } catch {
            /* déjà fermé */
          }
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    // Erreurs d'authentification/validation AVANT le démarrage du flux :
    // réponse JSON classique, traitée comme la route non-stream.
    const status = errorStatus(error, 400);
    if (status >= 500) {
      console.error("[messages/stream] erreur:", error instanceof Error ? error.message : error);
    }
    return Response.json(errorBody(error, "Le message n'a pas pu être traité."), { status });
  }
}
