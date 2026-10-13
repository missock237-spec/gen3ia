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
  generateImageWithAgnes,
  ImageGenerationError,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import { appendMessage, createConversation, getConversation, listMessages } from "@/lib/chat/repository";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";

const Body = z.object({
  conversationId: z.string().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(200_000),
  // « huggingface » retiré de l'enum (audit médias 103-c) : provider mort sans
  // adaptateur — une entrée client avec cette valeur est désormais rejetée à
  // la validation (400) au lieu d'échouer côté résolution de provider.
  provider: z.enum(["groq","openrouter","anthropic","openai","glm","agnes"]).optional(),
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
    let conversationId = body.conversationId;
    if (conversationId && !(await getConversation(user.uid, conversationId))) return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    if (!conversationId) conversationId = (await createConversation(user.uid, body.message.slice(0, 60))).id;

    // Historique AVANT l'ajout du message courant — les PLUS RÉCENTS
    // (ordre chronologique) : une conversation longue garde sa fin.
    const history = await listMessages(user.uid, conversationId, 100, { order: "recent" });
    await appendMessage({ conversationId, userId: user.uid, role: "user", content: body.message });

    // Génération d'images réelle (Agnes AI) : une demande explicite d'image
    // est servie directement — pas de réponse textuelle en guise d'image.
    if (looksLikeImageRequest(body.message)) {
      try {
        const image = await generateImageWithAgnes({ prompt: enhanceImagePrompt(body.message) });
        const reply = `Voici l'image que j'ai générée pour vous.`;
        const assistant = await appendMessage({
          conversationId, userId: user.uid, role: "assistant", content: reply,
          imageUrl: image.imageUrl, provider: "agnes", model: image.model,
        });
        return NextResponse.json({ conversationId, message: assistant, response: { provider: "agnes", model: image.model, latencyMs: image.latencyMs, finishReason: "stop" } });
      } catch (error) {
        // Panne image : on ne masque pas l'échec derrière une réponse textuelle.
        const message = error instanceof ImageGenerationError
          ? error.message
          : "La génération d'image a échoué. Réessayez dans un instant.";
        const assistant = await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: message });
        return NextResponse.json({ conversationId, message: assistant, response: { provider: "agnes", model: "image", finishReason: "error" } });
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
      metadata: { userId: user.uid, conversationId },
    });

    // Task 138 — SELF-REFLECTION : la proposition est critiquée (exactitude,
    // complétude, fiabilité, structure) avant d'être persistée et livrée.
    // Une seule passe, réponses substantielles uniquement ; fail-soft total —
    // une panne du réviseur livre la proposition d'origine.
    const reviewed = await reviewVisibleAnswer({ question: body.message, answer: stripThinkTags(response.text) });

    const assistant = await appendMessage({
      conversationId, userId: user.uid, role: "assistant", content: reviewed.text,
      provider: response.provider, model: response.model, usage: response.usage,
    });
    return NextResponse.json({ conversationId, message: assistant, response: { id: response.id, provider: response.provider, model: response.model, usage: response.usage, latencyMs: response.latencyMs, finishReason: response.finishReason } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "La génération IA a échoué." }, { status: errorStatus(error, 400) });
  }
}
