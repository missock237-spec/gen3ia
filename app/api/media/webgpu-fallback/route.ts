import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { resolveOrigineClient } from "@/lib/media/origine-client";
import { produceConversationImage } from "@/lib/domain/conversations/engine-chat";
import { genererVideoNeuralEtPersister } from "@/lib/neural/media-service";

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
      voix?: string;
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
      // Repli réel : professeur temporaire (photoréalisme, loi
      // CONTRAINTE-ONDES) ou moteur neuronal abstrait sans professeur.
      const image = await produceConversationImage({ message: prompt, userId }, prompt);
      const prof = (image as { echafaudage?: boolean }).echafaudage === true;
      const message = await appendMessage({
        conversationId,
        userId,
        role: "assistant",
        content: prof
          ? "Votre navigateur ne peut pas exécuter la génération WebGPU — mon professeur média temporaire a produit cette image photoréaliste (échafaudage supprimable : le signal d'onde gen3 prendra le relais après distillation)."
          : `Votre navigateur ne peut pas exécuter la génération WebGPU (${raison}). ` +
            "Je vous livre la composition de mon moteur neuronal interne — une composition abstraite, honnête, calculée depuis mon état synaptique.",
        imageUrl: image.inlineDataUrl ?? image.imageUrl,
        provider: prof ? "professeur-temporaire" : "gen3-snn",
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
        // DEMANDE PROPRIÉTAIRE (2026-11-11) : la voix respecte le PERSONNAGE
        // décrit (féminine/masculine) — la voix choisie par le tour (Edge
        // neural) est relayée à la cascade de parole (passerelle → espace
        // public ANONYME : la vraie parole ne dépend d'aucune configuration).
        // VOIX PARLÉE SEULE (2026-11-12) : plus jamais une nappe harmonique
        // déguisée en voix — aucun moteur de parole → échec honnête.
        const { genererVoixHumaineProfesseurEtPersister } = await import("@/lib/neural/media-service");
        const voix = typeof body.voix === "string" && body.voix.length > 0 && body.voix.length < 80 ? body.voix : undefined;
        const audio = await genererVoixHumaineProfesseurEtPersister({ userId, texte: prompt, ...(voix ? { voix } : {}) });
        if (!audio) {
          const message = await appendMessage({
            conversationId,
            userId,
            role: "assistant",
            content:
              "La synthèse vocale humaine est momentanément indisponible (aucun moteur de parole joignable). " +
              "Alternatives : Chrome/Edge récent côté client (synthèse WebGPU locale), ou réessayez dans un instant.",
            provider: "gen3",
            model: "gen3-fallback",
            generationStatus: "complete",
          });
          return NextResponse.json({ success: true, message });
        }
        const prof = audio.meta?.echafaudage === true;
        // LIVRAISON DURABLE (2026-11-12) : l'URL présignée expire (TTL 1 h) —
        // le message persisté porte l'URL canonique re-signée à chaque
        // résolution + le champ structuré audioUrl (lecteur du fil). Jamais
        // d'origine locale derrière proxy (constat production 2026-11-12).
        const { urlDurableAbsolue, urlDurableRelative } = await import("@/lib/media/url-durable");
        const lienJouable =
          audio.cleStockage
            ? (urlDurableAbsolue(audio.cleStockage, resolveOrigineClient(request)) ?? audio.url)
            : audio.url;
        const audioUrlDurable = audio.cleStockage ? (urlDurableRelative(audio.cleStockage) ?? undefined) : undefined;
        const message = await appendMessage({
          conversationId,
          userId,
          role: "assistant",
          content:
            (prof
              ? "Voix humaine réelle générée par mon professeur média temporaire (échafaudage — le signal d'onde gen3 prendra le relais après distillation). "
              : "Votre navigateur ne peut pas exécuter la synthèse WebGPU — voici la nappe sonore neuronale (composition abstraite, honnête). ") +
            `Écoutez ici : ${lienJouable}`,
          ...(audioUrlDurable ? { audioUrl: audioUrlDurable } : {}),
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
        // LIVRAISON DURABLE : même contrat que la voix — lien canonique
        // re-signé à chaque résolution, jamais une présignée expirable.
        const { urlDurableAbsolue } = await import("@/lib/media/url-durable");
        const lienVidéo =
          video.cleStockage
            ? (urlDurableAbsolue(video.cleStockage, resolveOrigineClient(request)) ?? video.url)
            : video.url;
        const message = await appendMessage({
          conversationId,
          userId,
          role: "assistant",
          content:
            (prof
              ? "Vidéo réaliste générée par mon professeur média temporaire (échafaudage — le signal d'onde gen3 prendra le relais après distillation). "
              : "Votre navigateur ne peut pas calculer les keyframes WebGPU — voici l'animation neuronale abstraite (honnête). ") +
            `Regardez ici : ${lienVidéo}`,
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
        // VIDÉO RÉELLE GARANTIE (2026-11-12, « gen3 doit pouvoir réaliser des
        // vidéos réalistes sans que l'utilisateur ait à le demander ») : si
        // le professeur n'a PAS produit (moteur professeur absent/injoignable
        // — constat production : passerelle privée injoignable d'un VPS), la
        // production AUTOPILOTÉE RÉELLE prend le relais : scénario, visuels,
        // voix, montage et rendu FFmpeg — un VRAI MP4 livré DANS CE FIL à la
        // complétion (carte vidéo + lien durable). L'animation neuronale
        // ci-dessus reste l'aperçu immédiat honnête.
        let jobRéel: { projectId: string } | null = null;
        if (!prof) {
          try {
            const { createVideoProductionJob } = await import("@/lib/video/production-queue");
            jobRéel = await createVideoProductionJob({
              userId,
              prompt: prompt.slice(0, 4000),
              conversationId,
              options: { targetDurationSec: Math.min(60, Math.max(10, body.durationSeconds ?? 15)) },
            });
          } catch (erreurProduction) {
            console.warn(
              "[webgpu-fallback] production vidéo réelle non lancée :",
              erreurProduction instanceof Error ? erreurProduction.message : String(erreurProduction),
            );
          }
        }
        if (jobRéel) {
          const messageProduction = await appendMessage({
            conversationId,
            userId,
            role: "assistant",
            content:
              "Et surtout : votre VIDÉO RÉELLE est en production complète sur mes moteurs serveur " +
              "(scénario, visuels, voix, montage, rendu FFmpeg). La vidéo terminée sera livrée " +
              "DIRECTEMENT dans ce fil — même si vous fermez la page. L'aperçu ci-dessus est mon " +
              "animation neuronale immédiate ; le master réaliste arrive derrière.",
            videoProjectId: jobRéel.projectId,
            provider: "gen3",
            model: "gen3-video-production",
            generationStatus: "complete",
          });
          return NextResponse.json({ success: true, message: messageProduction, artifact });
        }
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
