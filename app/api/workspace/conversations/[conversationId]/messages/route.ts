import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { clientIp } from "@/lib/security/rate-limit";
import { rateLimitDistributed } from "@/lib/cache/redis";
// Garde de charge (durcissement production) : un tour IA coûteux retient
// mémoire + fournisseurs — au-delà du plafond de tours simultanés, 429
// honnête avec Retry-After plutôt que dégradation de TOUT le monde.
import {
  acquiertourIa,
  RETRY_AFTER_SECONDES,
} from "@/lib/security/concurrency";
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES } from "@/lib/files/attachment-policy";
import { runConversationTurn } from "@/lib/domain/conversations/engine";
// Task 153 — paiement par exécution : réservation avant le tour complet
// (intention + plan + synthèse), règlement au coût réel après.
import { runWithExecutionBilling } from "@/lib/billing/execution-gate";

export const runtime = "nodejs";
// Conversation turns may orchestrate multiple providers/tools; 5 minutes avoids
// terminating legitimate long-running runs while keeping a bounded request lifetime.
export const maxDuration = 300;

type RouteContext = { params: Promise<{ conversationId: string }> };

// Contrat d'attachments ALIGNÉ sur messages/stream/route.ts : sans ces
// champs, zod 4 strippait fileId/fileKind/charCount/rowCount au repli
// non-stream — le contenu importé (loadImportedFilesContext) devenait
// introuvable alors que le flux NDJSON le conservait.
const AttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  path: z.string().trim().max(400).optional(),
  url: z.string().trim().max(2000).optional(),
  contentType: z.string().trim().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().max(ATTACHMENT_MAX_FILE_BYTES).optional(),
  fileId: z.string().trim().max(128).optional(),
  fileKind: z.string().trim().max(40).optional(),
  charCount: z.number().int().nonnegative().max(100_000_000).optional(),
  rowCount: z.number().int().nonnegative().max(10_000_000).optional(),
});

const ConnectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Slug de connecteur invalide.");

const BodySchema = z.object({
  message: z.string().trim().min(1).max(20000),
  // Politique unifiée des pièces jointes : 10 fichiers × 50 Mo max.
  attachments: z.array(AttachmentSchema).max(ATTACHMENT_MAX_FILES).optional(),
  projectId: z.string().trim().min(1).max(128).optional(),
  provider: z.string().trim().max(60).optional(),
  model: z.string().trim().max(200).optional(),
  connectors: z.array(ConnectorSchema).max(8).optional(),
  authorizationMode: z.enum(["always_ask", "ask_if_needed", "auto_allow"]).optional(),
  // Task 141 — agent dédié choisi dans le composer (sélecteur Gen IA ⇄ agents).
  agentId: z.string().trim().min(1).max(128).optional(),
  // Bouton « Recherche web » du composer : force une recherche réelle (web.search)
  // pour ce tour, quel que soit le routage heuristique du moteur.
  webSearch: z.boolean().optional(),
  // Fuseau horaire du client (IANA) : utilisé par les sous-services pilotés
  // en langage naturel (tâches planifiées).
  timezone: z.string().trim().max(100).optional(),
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

    // ── GARDE DE CONCURRENCE (admission des tours coûteux) ──
    const jeton = acquiertourIa("conversation-turn");
    if (!jeton) {
      return NextResponse.json(
        { error: "La plateforme est à pleine capacité. Réessayez dans quelques secondes." },
        { status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDES) } },
      );
    }

    try {
      // ── Task 153 — PORTILLON DE FACTURATION ──
      // Un tour de conversation peut enchaîner détection d'intention, plan et
      // synthèse finale : la réservation couvre le pire cas multi-appels.
      const inputTokens = Math.min(
        24_000,
        Math.max(64, Math.ceil(body.message.length / 3) + 2_000),
      );
      const { result, billing } = await runWithExecutionBilling({
        userId: user.uid,
        label: "conversation-turn",
        estimate: {
          task: "agent",
          inputTokens,
          outputTokens: 2_048,
          toolCalls: 3,
          calls: 3,
          complexity: 1.5,
        },
        fn: () =>
          runConversationTurn({
            userId: user.uid,
            conversationId,
            message: body.message,
            attachments: body.attachments,
            projectId: body.projectId,
            provider: body.provider,
            model: body.model,
            connectors: body.connectors,
            authorizationMode: body.authorizationMode,
            agentId: body.agentId,
            webSearch: body.webSearch,
            timezone: body.timezone,
          }),
      });
      return NextResponse.json({ ...result, billing });
    } finally {
      jeton.release();
    }
  } catch (error) {
    return NextResponse.json(errorBody(error, "Le message n'a pas pu être traité."), { status: errorStatus(error, 400) });
  }
}
