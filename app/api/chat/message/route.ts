import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { generate } from "@/lib/ai/router";
import {
  extractImagePrompt,
  generateImageWithAgnes,
  ImageGenerationError,
  looksLikeExplicitDrawingRequest,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import { enhanceImagePrompt } from "@/lib/ai/image-prompt-enhancer";
import { appendMessage, createConversation, getConversation, listMessages } from "@/lib/chat/repository";
import { errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  conversationId: z.string().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(20000),
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

    const history = await listMessages(user.uid, conversationId, 100);
    await appendMessage({ conversationId, userId: user.uid, role: "user", content: body.message });

    // Génération d'images réelle (Agnes AI) : une demande explicite d'image
    // est servie directement — pas de réponse textuelle en guise d'image.
    if (looksLikeImageRequest(body.message) || looksLikeExplicitDrawingRequest(body.message)) {
      try {
        // Prompt analysé puis amélioré par LLM (sujet intact, rendu optimisé).
        const { prompt: enhancedPrompt } = await enhanceImagePrompt(extractImagePrompt(body.message));
        const image = await generateImageWithAgnes({ prompt: enhancedPrompt, size: "2K", timeoutMs: 45_000 });
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

    const response = await generate({
      task: "chat",
      messages: [...history.map(m => ({ role: m.role, content: m.content })), { role: "user", content: body.message }],
      provider: body.provider, model: body.model, temperature: body.temperature, maxTokens: body.maxTokens, preferFree: body.preferFree ?? true,
      metadata: { userId: user.uid, conversationId },
    });

    const assistant = await appendMessage({
      conversationId, userId: user.uid, role: "assistant", content: response.text,
      provider: response.provider, model: response.model, usage: response.usage,
    });
    return NextResponse.json({ conversationId, message: assistant, response: { id: response.id, provider: response.provider, model: response.model, usage: response.usage, latencyMs: response.latencyMs, finishReason: response.finishReason } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "La génération IA a échoué." }, { status: errorStatus(error, 400) });
  }
}
