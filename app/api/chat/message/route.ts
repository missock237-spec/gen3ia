import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { generate } from "@/lib/ai/router";
import { stripThinkTags } from "@/lib/ai/think-filter";
import { preferFreeForVisibleAnswers, RESPONSE_FORMAT_RULES } from "@/lib/ai/response-quality";
import { REASONING_DIRECTIVE, composeStructuredPrompt } from "@/lib/ai/prompt-composer";
import { buildFewShotSection } from "@/lib/ai/few-shot";
import { reviewVisibleAnswer } from "@/lib/ai/self-review";
import { assembleMessages } from "@/lib/ai/context-window";
import {
  enhanceImagePrompt,
  looksLikeImageRequest,
} from "@/lib/ai/image-intent";
import { appendMessage, createConversation, getConversation, listMessages } from "@/lib/chat/repository";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";
// Task 153 — paiement par exécution : réservation AVANT toute génération,
// règlement au réel après (coûts externes + marge projet).
import { runWithExecutionBilling } from "@/lib/billing/execution-gate";
import { recordExternalCostForBilling } from "@/lib/billing/execution-meter";

function imageExternalCostEur(): number {
  const parsed = Number(process.env.COST_IMAGE_GENERATION_EUR_PER_IMAGE);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.04;
}

const Body = z.object({
  conversationId: z.string().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(200_000),
  // « huggingface » retiré de l'enum (audit médias 103-c) : provider mort sans
  // adaptateur — une entrée client avec cette valeur est désormais rejetée à
  // la validation (400) au lieu d'échouer côté résolution de provider.
  provider: z.literal("gen3-snn").optional(),
  model: z.string().trim().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(20000).optional(),
  preferFree: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // Coût LLM réel par appel : garde-fou anti-abus (aligné sur /api/agent/chat).
    const limit = await enforceRateLimit(`chat-message:${user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de messages rapprochés. Réessayez dans quelques instants." },
        { status: 429, headers: { "retry-after": String(Math.ceil((limit.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }
    const body = Body.parse(await request.json());
    const imageRequest = looksLikeImageRequest(body.message);

    // ── Task 153 — PORTILLON DE FACTURATION ────────────────────────────
    // Le pire coût de l'interaction est RÉSERVÉ sur le portefeuille AVANT
    // toute exécution (solde insuffisant → 402 immédiat, aucun token
    // consommé) ; le règlement final reprend le coût EXTERNE réel (tokens
    // consommés + coût image éventuel) majoré de la marge du projet.
    const inputTokens = Math.min(
      24_000,
      Math.max(64, Math.ceil(body.message.length / 3) + 2_500 /* system + fenêtre d'historique */),
    );
    const { result, billing } = await runWithExecutionBilling({
      userId: user.uid,
      label: "chat-message",
      estimate: {
        task: "chat",
        inputTokens,
        outputTokens: body.maxTokens ?? 4_096,
        toolCalls: 1,
        calls: imageRequest ? 1 : 2,
        ...(imageRequest ? { externalToolCostEur: imageExternalCostEur() } : {}),
      },
      fn: () => handleChatMessage(user.uid, body, imageRequest),
    });

    // Le résumé de facturation accompagne CHAQUE réponse : l'UI peut
    // afficher ce que l'exécution a réellement coûté.
    return NextResponse.json({ ...result.payload, billing }, { status: result.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "La génération IA a échoué." }, { status: errorStatus(error, 400) });
  }
}

/** Logique métier du tour de chat, exécutée derrière le portillon de facturation. */
async function handleChatMessage(
  userId: string,
  body: z.infer<typeof Body>,
  imageRequest: boolean,
): Promise<{ status: number; payload: Record<string, unknown> }> {
    let conversationId = body.conversationId;
    if (conversationId && !(await getConversation(userId, conversationId))) return { status: 404, payload: { error: "Conversation introuvable." } };
    if (!conversationId) conversationId = (await createConversation(userId, body.message.slice(0, 60))).id;

    // Historique AVANT l'ajout du message courant — les PLUS RÉCENTS
    // (ordre chronologique) : une conversation longue garde sa fin.
    const history = await listMessages(userId, conversationId, 100, { order: "recent" });
    await appendMessage({ conversationId, userId, role: "user", content: body.message });

    // Génération d'images NEURONALE LOCALE : les imageurs externes (Agnes)
    // ont été supprimés du projet — la composition est calculée par le
    // moteur Gen3 depuis l'état réel du cerveau (tarif nul).
    if (imageRequest) {
      try {
        const { genererVisuelNeuralEtPersister } = await import("@/lib/neural/media-service");
        const image = await genererVisuelNeuralEtPersister({ userId, prompt: enhanceImagePrompt(body.message) });
        const reply = `Voici la composition neuronale que j'ai générée pour vous.`;
        const assistant = await appendMessage({
          conversationId, userId, role: "assistant", content: reply,
          imageUrl: image.url, provider: "gen3-snn", model: "gen3-snn-v1",
        });
        return { status: 200, payload: { conversationId, message: assistant, response: { provider: "gen3-snn", model: "gen3-snn-v1", latencyMs: 0, finishReason: "stop" } } };
      } catch (error) {
        // Panne image : on ne masque pas l'échec derrière une réponse textuelle.
        const message = error instanceof Error
          ? error.message
          : "La génération d'image a échoué. Réessayez dans un instant.";
        const assistant = await appendMessage({ conversationId, userId, role: "assistant", content: message });
        return { status: 200, payload: { conversationId, message: assistant, response: { provider: "gen3-snn", model: "gen3-snn-v1", finishReason: "error" } } };
      }
    }

    // Task 52 (qualité comparable à ChatGPT à chaque requête) + Task 138
    // (ingénierie de prompt structurée) :
    //  - un SYSTEM PROMPT STRUCTURÉ (rôle → méthode de raisonnement par
    //    étapes → contraintes strictes → format de sortie → exemples
    //    few-shot) existe DÈS LA PREMIÈRE réponse — le squelette normalisé
    //    remplace l'assemblage ad-hoc ;
    //  - l'historique est assemblé dans la FENÊTRE DU MODÈLE (compression
    //    extractive au lieu d'un empilement brut de 100 messages) ;
    //  - le routage suit la politique de qualité des réponses visibles
    //    (meilleur fournisseur configuré, sauf choix explicite du client) ;
    //  - une passe de SELF-REFLECTION critique la proposition avant
    //    livraison (réponses substantielles uniquement, fail-soft) ;
    //  - le texte est débarrassé des balises de raisonnement interne.
    const systemPrompt = composeStructuredPrompt({
      role: "Tu es l'assistant IA universel de Gen3ia. À CHAQUE requête, quelle que soit sa longueur, tu produis une réponse d'exigence professionnelle : claire, précise et adaptée au sujet saisi — la même qualité qu'un assistant de premier plan. Tu réponds à toutes les questions générales, techniques, créatives ou professionnelles.",
      method: REASONING_DIRECTIVE,
      constraints: [
        "Comprends la demande actuelle à la lumière de tout l'historique fourni.",
        "N'invente jamais un fait, une action exécutée, un résultat ou une source.",
        "Si une information manque, dis-le au lieu de la compléter par supposition.",
        "Retourne uniquement le résultat demandé par l'utilisateur ; ta réflexion préparatoire reste interne.",
      ],
      outputFormat: RESPONSE_FORMAT_RULES,
      examples: buildFewShotSection(body.message),
    });
    const { messages } = assembleMessages({
      system: systemPrompt,
      history: history.map((item) => ({ role: item.role, content: item.content })),
      message: body.message,
      model: body.model ?? null,
      reservedOutputTokens: body.maxTokens ?? 4_096,
      keepRecent: 16,
    });

    const response = await generate({
      task: "chat",
      messages,
      provider: body.provider, model: body.model, temperature: body.temperature,
      maxTokens: body.maxTokens ?? 4_096,
      preferFree: body.preferFree ?? preferFreeForVisibleAnswers(),
      metadata: { userId, conversationId },
    });

    // Task 138 — SELF-REFLECTION : la proposition est critiquée (exactitude,
    // complétude, fiabilité, structure) avant d'être persistée et livrée.
    // Une seule passe, réponses substantielles uniquement ; fail-soft total —
    // une panne du réviseur livre la proposition d'origine.
    const reviewed = await reviewVisibleAnswer({ question: body.message, answer: stripThinkTags(response.text) });

    const assistant = await appendMessage({
      conversationId, userId, role: "assistant", content: reviewed.text,
      provider: response.provider, model: response.model, usage: response.usage,
    });
    return { status: 200, payload: { conversationId, message: assistant, response: { id: response.id, provider: response.provider, model: response.model, usage: response.usage, latencyMs: response.latencyMs, finishReason: response.finishReason } } };
}
