import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { generate } from "@/lib/ai/router";
import { stripThinkTags } from "@/lib/ai/think-filter";
import { withResponseStyle, preferFreeForVisibleAnswers } from "@/lib/ai/response-quality";
import { assembleMessages } from "@/lib/ai/context-window";
import {
  enhanceImagePrompt,
  generateImageWithAgnes,
  ImageGenerationError,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import { appendMessage, createConversation, getConversation, listMessages } from "@/lib/chat/repository";
import { errorStatus } from "@/lib/security/http-errors";

const Body = z.object({
  conversationId: z.string().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(200_000),
  provider: z.enum(["groq","openrouter","anthropic","openai","glm","agnes","huggingface"]).optional(),
  model: z.string().trim().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(20000).optional(),
  preferFree: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
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

    // Task 52 (qualité comparable à ChatGPT à chaque requête) :
    //  - un SYSTEM PROMPT de qualité existe DÈS LA PREMIÈRE réponse (l'absence
    //    totale de consignes était le premier écart : le modèle brut répondait
    //    sans cadre de clarté, de structure ni d'honnêteté) ;
    //  - l'historique est assemblé dans la FENÊTRE DU MODÈLE (compression
    //    extractive au lieu d'un empilement brut de 100 messages) ;
    //  - le routage suit la politique de qualité des réponses visibles
    //    (meilleur fournisseur configuré, sauf choix explicite du client) ;
    //  - le texte est débarrassé des balises de raisonnement <think>.
    const { messages } = assembleMessages({
      system: withResponseStyle(),
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

    const assistant = await appendMessage({
      conversationId, userId: user.uid, role: "assistant", content: stripThinkTags(response.text),
      provider: response.provider, model: response.model, usage: response.usage,
    });
    return NextResponse.json({ conversationId, message: assistant, response: { id: response.id, provider: response.provider, model: response.model, usage: response.usage, latencyMs: response.latencyMs, finishReason: response.finishReason } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "La génération IA a échoué." }, { status: errorStatus(error, 400) });
  }
}
