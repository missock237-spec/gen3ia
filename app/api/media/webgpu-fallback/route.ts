import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { produceConversationImage } from "@/lib/domain/conversations/engine-chat";
import {
  genererAudioNeuralEtPersister,
  genererVideoNeuralEtPersister,
} from "@/lib/neural/media-service";

export const runtime = "nodejs";
/** La vidéo professeur (tâche asynchrone + sondage) peut prendre plusieurs
 *  minutes — la route doit vivre au-delà du proxy par défaut. */
export const maxDuration = 300;

/**
 * /api/media/webgpu-fallback — repli HONNÊTE quand le navigateur ne peut
 * pas exécuter la génération WebGPU (pas de WebGPU, VRAM insuffisante,
 * échec de téléchargement…). Le serveur reprend le tour avec ses propres
 * moteurs : image → photoréalisme du PROFESSEUR TEMPORAIRE (loi
 * CONTRAINTE-ONDES — échafaudage supprimable) puis composition neuronale
 * abstraite ; voix → voix humaine réelle du professeur ; vidéo → vidéo
 * réaliste du professeur. Sans professeur configuré, moteurs neuronaux
 * locaux + explication honnête, jamais de faux succès.
 */

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = (await request.json()) as {
      jobId?: string;
      conversationId?: string;
      kind?: "image" | "voice" | "video";
      prompt?: string;
      ratio?: string;
      durationSeconds?: number;
      raison?: string;
    };
    const { conversationId, kind, prompt } = body;
    const userId = guard.context.userId;
    if (!conversationId || !kind) {
      return NextResponse.json(
        { success: false, error: "conversationId et kind requis." },
        { status: 400 },
      );
    }
    const raison = (body.raison ?? "WebGPU indisponible").slice(0, 200);

    if (kind === "image" && prompt) {
      // Repli réel : moteur neuronal abstrait du serveur (aucune IA externe).
      const image = await produceConversationImage({ message: prompt, userId }, prompt);
      const message = await appendMessage({
        conversationId,
        userId,
        role: "assistant",
        content:
          `Votre navigateur ne peut pas exécuter la génération WebGPU (${raison}). ` +
          "Je vous livre la composition de mon moteur neuronal interne — une composition abstraite, honnête, calculée depuis mon état synaptique.",
        imageUrl: image.inlineDataUrl ?? image.imageUrl,
        provider: "gen3-snn",
        model: image.model,
        generationStatus: "complete",
      });
      const artifact = await createArtifact({
        userId,
        conversationId,
        type: "image",
        title: prompt.slice(0, 80),
        url: image.inlineDataUrl ?? image.imageUrl,
        storagePath: image.storagePath,
        note: `Repli neuronal (WebGPU indisponible : ${raison})`,
      });
      return NextResponse.json({ success: true, message, artifact });
    }

    // Voix / vidéo : médias RÉELS du professeur temporaire (loi
    // CONTRAINTE-ONDES) ; sans professeur, explication honnête.
    if (kind === "voice" && prompt) {
      try {
        const audio = await genererAudioNeuralEtPersister({ userId, prompt });
        const prof = audio.meta?.echafaudage === true;
        const message = await appendMessage({
          conversationId,
          userId,
          role: "assistant",
          content:
            (prof
              ? "Voix humaine réelle générée par mon professeur média temporaire (échafaudage — le signal d'onde gen3 prendra le relais après distillation). "
              : "Votre navigateur ne peut pas exécuter la synthèse WebGPU — voici la nappe sonore neuronale (composition abstraite, honnête). ") +
            `Écoutez ici : ${audio.url}`,
          provider: prof ? "professeur-temporaire" : "gen3-snn",
          model: String(audio.meta?.moteur ?? "gen3-snn-audio"),
          generationStatus: "complete",
        });
        const artifact = await createArtifact({
          userId,
          conversationId,
          type: "audio",
          title: prompt.slice(0, 80),
          url: audio.url,
          storagePath: audio.cleStockage,
          note: prof ? "Voix du professeur temporaire (CONTRAINTE-ONDES)" : "Nappe neuronale",
        });
        return NextResponse.json({ success: true, message, artifact });
      } catch (erreur) {
        const message = await appendMessage({
          conversationId,
          userId,
          role: "assistant",
          content:
            `La synthèse vocale humaine a échoué (${erreur instanceof Error ? erreur.message.slice(0, 140) : "erreur"}). ` +
            "Alternatives : Chrome/Edge récent côté client (WebGPU), ou réessayez dans un instant.",
          provider: "gen3",
          model: "gen3-fallback",
          generationStatus: "complete",
        });
        return NextResponse.json({ success: true, message });
      }
    }

    if (kind === "video" && prompt) {
      try {
        const video = await genererVideoNeuralEtPersister({ userId, prompt, dureeSecondes: body.durationSeconds ?? 5 });
        const prof = video.meta?.echafaudage === true;
        const message = await appendMessage({
          conversationId,
          userId,
          role: "assistant",
          content:
            (prof
              ? "Vidéo réaliste générée par mon professeur média temporaire (échafaudage — le signal d'onde gen3 prendra le relais après distillation). "
              : "Votre navigateur ne peut pas calculer les keyframes WebGPU — voici l'animation neuronale abstraite (honnête). ") +
            `Regardez ici : ${video.url}`,
          provider: prof ? "professeur-temporaire" : "gen3-snn",
          model: String(video.meta?.moteur ?? "gen3-snn-video"),
          generationStatus: "complete",
        });
        const artifact = await createArtifact({
          userId,
          conversationId,
          type: "video",
          title: prompt.slice(0, 80),
          url: video.url,
          storagePath: video.cleStockage,
          note: prof ? "Vidéo du professeur temporaire (CONTRAINTE-ONDES)" : "Animation neuronale",
        });
        return NextResponse.json({ success: true, message, artifact });
      } catch (erreur) {
        const message = await appendMessage({
          conversationId,
          userId,
          role: "assistant",
          content:
            `La génération vidéo a échoué (${erreur instanceof Error ? erreur.message.slice(0, 140) : "erreur"}). ` +
            "Alternatives : Chrome/Edge récent côté client, ou la production vidéo autopilote du serveur (atelier vidéo).",
          provider: "gen3",
          model: "gen3-fallback",
          generationStatus: "complete",
        });
        return NextResponse.json({ success: true, message });
      }
    }

    // Repli générique (kind inconnu) : explication honnête, jamais de faux succès.
    const message = await appendMessage({
      conversationId,
      userId,
      role: "assistant",
      content:
        `Génération WebGPU indisponible (${raison}). ` +
        "Alternatives : Chrome/Edge récent côté client, ou mes moteurs serveur (image, voix, vidéo) — reformulez votre demande.",
      provider: "gen3",
      model: "gen3-fallback",
      generationStatus: "complete",
    });
    return NextResponse.json({ success: true, message });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Repli échoué" },
      { status: 500 },
    );
  }
}
