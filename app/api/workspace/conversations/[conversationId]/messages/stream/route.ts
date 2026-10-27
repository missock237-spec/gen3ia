import { NextRequest } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { clientIp } from "@/lib/security/rate-limit";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { definirContexteRequeteTenant } from "@/lib/observability/contexte-requete";
import { runConversationTurn } from "@/lib/domain/conversations/engine";
import type { ConversationStreamEvent } from "@/lib/domain/conversations/stream-events";
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES } from "@/lib/files/attachment-policy";
// Task 153 — paiement par exécution : réservation AVANT le flux (402
// immédiat si solde insuffisant), règlement au réel à la fin du tour.
import { openExecutionBilling } from "@/lib/billing/execution-gate";
// Garde de charge (durcissement production) : admission des tours coûteux —
// 429 honnête + Retry-After au-delà du plafond de tours simultanés.
import { acquiertourIa, RETRY_AFTER_SECONDES } from "@/lib/security/concurrency";

export const runtime = "nodejs";
// Conversation turns may orchestrate multiple providers/tools; 5 minutes avoids
// terminating legitimate long-running runs while keeping a bounded request lifetime.
export const maxDuration = 300;

type RouteContext = { params: Promise<{ conversationId: string }> };

const ConnectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Slug de connecteur invalide.");

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

    // Corrélation logs : TOUTE la chaîne async du tour (moteur, mémoires,
    // facturation) hérite de conversationId dans le contexte pino (ALS).
    definirContexteRequeteTenant({ conversationId, userId: user.uid });

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

    // ── GARDE DE CONCURRENCE (admission des tours coûteux) ──
    // Le jeton est libéré quand le flux S'ACHÈVE (succès, échec ou
    // déconnexion client — cancel) : le créneau couvre la durée RÉELLE
    // du tour dans le stream, pas seulement l'ouverture.
    const jeton = acquiertourIa("conversation-stream");
    if (!jeton) {
      return Response.json(
        { error: "La plateforme est à pleine capacité. Réessayez dans quelques secondes." },
        { status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDES) } },
      );
    }

    // ── Task 153 — PORTILLON DE FACTURATION (session à complétion différée) ──
    // La réservation est prise AVANT l'ouverture du flux : un solde
    // insuffisant renvoie un 402 JSON classique, avant tout token consommé.
    // Le règlement au réel survient quand le tour s'achève dans le flux.
    const inputTokens = Math.min(
      24_000,
      Math.max(64, Math.ceil(body.message.length / 3) + 2_000),
    );
    const billingSession = await openExecutionBilling({
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
    });

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

        // Tout le tour s'exécute DANS la session de facturation : chaque
        // appel LLM du moteur est compté au réel (AsyncLocalStorage).
        await billingSession.run(async () => {
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
              agentId: body.agentId,
              webSearch: body.webSearch,
              timezone: body.timezone,
              onEvent: send,
            });
            void result;

            // Règlement au réel, puis événement facturation pour l'UI.
            try {
              const summary = await billingSession.settle();
              send({
                type: "billing",
                label: summary.label,
                currency: summary.currency,
                chargeMinor: summary.chargeMinor,
                reservedMinor: summary.reservedMinor,
                providerCostEur: summary.providerCostEur,
                marginEur: summary.marginEur,
                llmCalls: summary.llmCalls,
                inputTokens: summary.inputTokens,
                outputTokens: summary.outputTokens,
              });
            } catch (settleError) {
              console.error("[messages/stream] règlement impossible (fail-soft) :", settleError instanceof Error ? settleError.message : settleError);
            }

            // L'événement « done » est émis par le moteur lui-même : le flux
            // se referme proprement ici.
            closed = true;
            controller.close();
          } catch (error) {
            // Échec du tour : réservation libérée (jamais facturé).
            await billingSession.release();
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
        });
        // Tour achevé (succès ou échec) : le créneau de concurrence est rendu.
        jeton.release();
      },
      cancel() {
        closed = true;
        // Annulation client : la réservation sera libérée si le tour
        // échoue, réglée au réel s'il aboutit (la persistance reste
        // autoritaire — on ne coupe pas le moteur ici). Le créneau de
        // concurrence est rendu immédiatement : la déconnexion libère la
        // capacité même si le moteur finit son tour en arrière-plan.
        jeton.release();
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
