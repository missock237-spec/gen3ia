import "server-only";

/**
 * Tours « image » (édition d'image existante, génération) et « vidéo » (production autopilote déléguée à la file de production). Extrait de engine.ts — code déplacé tel quel.
 */

import { safeEmitter } from "./stream-events";
import { detectImageRatio } from "@/lib/ai/image-intent";
import { extractVideoParams, extractVideoTitle } from "@/lib/ai/video-intent";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { attachmentImageCandidates, resolveEditableImageSources } from "@/lib/files/image-source";
import { produceConversationImage } from "./engine-chat";
import type { TurnBase } from "./engine-chat";
import type { ConversationTurnResult } from "./engine-turn";
import { randomUUID } from "node:crypto";

/**
 * VIDÉO COURTE RÉALISTE (loi CONTRAINTE-ONDES) : une demande de vidéo
 * « réaliste » sans durée longue est servie par le circuit média direct
 * (essaim → GPU local → repli serveur → professeur temporaire) plutôt que
 * par la production autopilotée (storyboard complet, pensée pour les
 * formats longs). Détection déterministe, zéro LLM.
 */
export function estVideoCourteRéaliste(message: string): boolean {
  if (!/\b(r[eé]aliste|realistic|photor[eé]aliste|photorealistic)\b/i.test(message)) return false;
  // Longueur longue → production autopilotée (storyboard, chapitres…).
  if (/\b(dur[eé]e|minutes?|mins?|long|m[ée]trage|documentaire|film complet)\b.*\b(dur[eé]e|minutes?|mins?|long|m[ée]trage|documentaire)\b/i.test(message)) return false;
  if (/\b([2-9]\d|\d{3,})\s*(s|sec|secondes|minutes?|mins?)\b/i.test(message)) return false;
  if (/\b(\d{2,})\s*(s|sec|secondes)\b/i.test(message) && !/\b([1-9]|10)\s*(s|sec|secondes)\b/i.test(message)) return false;
  return true;
}

/** Repo public des modèles média WebGPU (publié par le notebook Colab
 *  training/colab/gen3ia_gpu_media_training.ipynb — SD photoréalisme + Kokoro). */
const WEBGPU_MEDIA_REPO = "Kings237/gen3ia-media-engine";

/**
 * Tour « ÉDITION d'image » (étape 8) : une image EXISTANTE — jointe au
 * message (import utilisateur) ou générée plus tôt dans la conversation —
 * est réellement modifiée via Agnes image-to-image. La source est résolue
 * en Data URI côté serveur (fiable), le résultat est persisté comme les
 * autres images (R2 / inline) et joint à un artefact. Échec = message
 * honnête dans le fil, jamais de faux succès.
 */
export async function runImageEditTurn(ctx: TurnBase, lastConversationImage: string | null): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    const attachmentSources = (ctx.attachments ?? []).flatMap((attachment) => attachmentImageCandidates(attachment));
    const rawSources = attachmentSources.length > 0 ? attachmentSources : lastConversationImage ? [lastConversationImage] : [];
    if (rawSources.length === 0) {
      throw new Error(
        "Aucune image à éditer n'a été trouvée. Joignez l'image à votre message (📎) ou générez-en une d'abord, puis redemandez la modification.",
      );
    }
    const sources = await resolveEditableImageSources(rawSources);
    // ÉDITION PIXEL SUPPRIMÉE (modèle d'édition externe retiré) : la demande
    // est honorée par une RÉGÉNÉRATION neuronale locale intégrant la consigne
    // — honnête : composition recalculée, pas retouche pixel par pixel.
    const { genererVisuelNeuralEtPersister } = await import("@/lib/neural/media-service");
    const image = await genererVisuelNeuralEtPersister({
      userId: ctx.userId,
      prompt: ctx.message.trim().slice(0, 4000),
      ratio: detectImageRatio(ctx.message),
    });
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: "Voici votre nouvelle composition neuronale, recalculée avec votre consigne de modification. L'original reste disponible dans les artefacts de la conversation.",
      imageUrl: image.url,
      provider: "gen3-snn",
      model: "gen3-snn-v1",
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "image",
      title: ctx.message.slice(0, 80),
      url: image.url,
      note: `Régénéré par le moteur neuronal Gen3 (${sources.length} source(s) conservée(s))`,
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande d'édition d'une image existante." },
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "L'édition d'image a échoué. Réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande d'édition d'une image existante." },
    };
  }
}

/** Détection PHOTORÉALISTE (déterministe, aucune variance LLM) : la demande
 *  vise un rendu photographique réaliste → la génération est déléguée au
 *  GPU de l'UTILISATEUR (WebGPU, modèles gen3ia-media-engine). Le moteur
 *  neuronal abstrait reste le repli honnête (API webgpu-fallback). */
const PHOTOREAL_PATTERN =
  /\b(photor[eé]aliste|photorealistic|photor[eé]alisme|tr[eè]s r[eé]aliste|hyper r[eé]aliste|ultra r[eé]aliste|rendu photo|r[eé]aliste comme une vraie|comme une vraie photo|vraie photo|r[eé]alistic|hyperrealistic|true[- ]to[- ]life|photographique)\b/i;

export function looksLikePhotorealRequest(message: string): boolean {
  return PHOTOREAL_PATTERN.test(message);
}

/**
 * VOIX HUMAINE DEMANDÉE (loi CONTRAINTE-ONDES) : « génère une voix qui
 * dit X », « fais une voix humaine disant X »… Détection déterministe
 * VOLONTAIREMENT SERRÉE : il faut le mot VOIX + un verbe de création ou
 * « qui dit/disant » — jamais les agents téléphoniques (« standardiste »)
 * ni la lecture vocale native de l'interface.
 */
export function looksLikeVoixHumaineRequest(message: string): boolean {
  const motVoix = /\b(voix humaine|voix\s+(?:de|qui|d'un|d'une)|synth[eè]se vocale|voice ?over|voix off)\b/iu.test(message)
    || /\bvoix\b/iu.test(message) && /\b(g[eé]n[eè]re|g[eé]n[eé]ration|fais|fait|cr[ée]\p{L}*|produi\p{L}*|synth[ée]tis\p{L}*|enregistre|dire|dit|disant)\b/iu.test(message);
  if (!motVoix) return false;
  // Exclusions strictes : agents téléphoniques / standard / cloches…
  if (/\b(standardiste|standard t[eé]l[eé]phonique|agent (?:t[eé]l[eé]phonique|vocal)|r[eé]pondeur)\b/i.test(message)) return false;
  return true;
}

/**
 * Phrase À DIRE extraite d'une demande de voix : la citation entre «…»,
 * «…», “…” ou "…" est prioritaire (l'instruction n'est pas lue à voix
 * haute). Sans citation, la demande entière est retournée.
 */
export function extrairePhraseÀDire(message: string): string {
  // Doubles chevrons ASCII «<<…>>» (usage courant au clavier).
  const chevrons = /<<\s*([^<>]{2,600}?)\s*>>/u.exec(message);
  if (chevrons?.[1]) return chevrons[1].trim();
  // Guillemets français «…»
  const guillemets = /«\s*([^«»]{2,600}?)\s*»/u.exec(message);
  if (guillemets?.[1]) return guillemets[1].trim();
  // Guillemets droits / typographiques "…" “…”
  const droits = /["“”]\s*([^"“”]{2,600}?)\s*["“”]/u.exec(message);
  if (droits?.[1]) return droits[1].trim();
  return message.trim();
}

/**
 * DEMANDE MÉDIA ÉTIQUETÉE : « Image : … », « Voix : … », « Vidéo : … » —
 * format courant de test où la demande COMMENCE par le type de média suivi
 * de deux-points (aucun verbe de création). Détection déterministe serrée
 * : l'étiquette doit être le PREMIER mot du message.
 */
export function intentionMédiaÉtiquetée(message: string): "image" | "voix" | "video" | null {
  const m = /^\s*(image|photo|photor[eé]aliste|voix|voice|vid[ée]o|video)\s*[:：]/iu.exec(message);
  if (!m?.[1]) return null;
  const étiquette = m[1].toLowerCase();
  if (/voix|voice/.test(étiquette)) return "voix";
  if (/vid/.test(étiquette)) return "video";
  return "image";
}

export async function runVoixTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const phrase = extrairePhraseÀDire(ctx.message);
  const jobId = randomUUID();
  await onEvent({
    type: "webgpu_media",
    jobId,
    conversationId: ctx.conversationId,
    kind: "voice",
    prompt: phrase.slice(0, 2000),
    engine: { repo: WEBGPU_MEDIA_REPO, manifest: "MANIFEST.json" },
  });
  const messageVoix = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content:
      "Synthèse de voix humaine lancée : votre requête part vers l'IA centrale de l'essaim gen3, " +
      "puis vers les GPU disponibles. Si aucun GPU du maillage ne peut calculer, mon professeur média " +
      "temporaire synthétise la voix réelle et je vous la livre dans ce fil (échafaudage — loi " +
      "CONTRAINTE-ONDES : le signal d'onde gen3 prendra le relais après distillation).",
    provider: "gen3-webgpu",
    model: "gen3-media-engine-v1",
    generationStatus: "complete",
  });
  await onEvent({ type: "message_complete", message: messageVoix });
  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage: messageVoix,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Demande de voix humaine via circuit média direct." },
  };
}

export async function runImageTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    // MÉDIA WEBGPU : demande photoréaliste → directive de génération
    // LOCALE sur le GPU de l'utilisateur (SD 2.1 + LoRA photoréalisme,
    // repo public gen3ia-media-engine). Le message persisté explique
    // honnêtement la prise en charge et le repli automatique.
    if (looksLikePhotorealRequest(ctx.message)) {
      const jobId = randomUUID();
      await onEvent({
        type: "webgpu_media",
        jobId,
        conversationId: ctx.conversationId,
        kind: "image",
        prompt: ctx.message.trim().slice(0, 2000),
        ratio: detectImageRatio(ctx.message),
        engine: { repo: WEBGPU_MEDIA_REPO, manifest: "MANIFEST.json" },
      });
      const messageWebGpu = await appendMessage({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        role: "assistant",
        content:
          "Génération photoréaliste lancée : votre requête part vers l'IA centrale de l'essaim gen3, " +
          "qui la décompose en parts et les distribue aux 5 meilleurs GPU disponibles (le vôtre " +
          "participe via l'agent gen3 installé dans votre navigateur — les modèles téléchargent et " +
          "génèrent en WebGPU, les résultats sont fusionnés puis renvoyés). " +
          "Première génération : téléchargement des modèles (~1 à 2 Go, une seule fois). " +
          "Si l'essaim ou votre navigateur ne peut pas calculer, je basculerai automatiquement sur mon moteur neuronal abstrait.",
        provider: "gen3-webgpu",
        model: "gen3-media-engine-v1",
        generationStatus: "complete",
      });
      await onEvent({ type: "message_complete", message: messageWebGpu });
      return {
        conversationId: ctx.conversationId,
        userMessage: ctx.userMessage,
        assistantMessage: messageWebGpu,
        artifacts: [],
        approvals: [],
        intent: { mode: "chat", understanding: "Génération d'image photoréaliste via WebGPU local." },
      };
    }

    // Progression RÉELLE émise par le serveur au fil des étapes réelles
    // (amélioration → génération → enregistrement) — cadre de progression
    // temps réel côté client (Task « cadre de progression »).
    const image = await produceConversationImage(ctx, undefined, async ({ label, stage, percent }) => {
      await onEvent({ type: "status", phase: "image", label, stage, percent });
    });
    await onEvent({ type: "status", phase: "image", label: "Image prête.", stage: "complete", percent: 100 });
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: "Voici l'image que j'ai générée pour vous. Elle est également enregistrée dans les artefacts de la conversation.",
      imageUrl: image.inlineDataUrl ?? image.imageUrl,
      provider: "gen3-snn",
      model: image.model,
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "image",
      title: ctx.message.slice(0, 80),
      url: image.inlineDataUrl ?? image.imageUrl,
      storagePath: image.storagePath,
      note: `Généré par le moteur neuronal Gen3 (${image.model})`,
    });
    // Contrat de flux complet : le client doit recevoir la même séquence
    // d'événements que les autres tours (audit 25-a : message_complete et
    // artifact_created manquaient sur le tour image).
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de génération d'image." },
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "La génération d'image a échoué. Réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de génération d'image." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « vidéo » — production COMPLÈTE autopilotée + artefact suivi   */
/* ------------------------------------------------------------------ */

/**
 * La demande vidéo de l'utilisateur lance une PRODUCTION RÉELLE complète :
 * la file `videoProductionJobs` (lib/video/production-queue) enchaîne — une
 * étape par tick QStash (repli : continuation par sondage) — création du
 * projet, plan du réalisateur, scénario, visuels de scènes (Consistency
 * Engine, facturation image existante), narration vocale, musique, puis le
 * rendu FFmpeg avec contrôle qualité. La conversation reçoit IMMÉDIATEMENT
 * un artefact de type "video" portant projectId/jobId : le client sonde la
 * progression réelle (GET production) et affiche le rendu final.
 */
/**
 * Task 135 — tour vidéo après clarification : l'utilisateur a répondu à une
 * question 🔄 posée à la suite d'une demande de vidéo — la production est
 * lancée avec le BRIEF RECOMPOSÉ (demande d'origine + précision apportée),
 * les paramètres déterministes (durée, format, effets, sous-titres…) étant
 * lus dans le texte COMPLET.
 */
export async function runVideoTurn(
  ctx: TurnBase,
  options: { effectivePrompt?: string } = {},
): Promise<ConversationTurnResult> {
  const promptText = options.effectivePrompt?.trim() || ctx.message;
  const onEvent = safeEmitter(ctx.onEvent);

  // VIDÉO COURTE RÉALISTE → circuit média direct (essaim → GPU local →
  // repli serveur → professeur temporaire). Message honnête + événement
  // webgpu_media kind=video : le hook client enchaîne la cascade réelle.
  if (estVideoCourteRéaliste(promptText)) {
    const jobId = randomUUID();
    await onEvent({
      type: "webgpu_media",
      jobId,
      conversationId: ctx.conversationId,
      kind: "video",
      prompt: promptText.trim().slice(0, 2000),
      ratio: "16:9",
      durationSeconds: 5,
      engine: { repo: WEBGPU_MEDIA_REPO, manifest: "MANIFEST.json" },
    });
    const messageDirect = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        "Génération vidéo réaliste lancée : votre requête part vers l'IA centrale de l'essaim gen3, " +
        "puis vers les GPU disponibles (le vôtre en premier). Si aucun GPU du maillage ne peut calculer, " +
        "mon professeur média temporaire produit la vidéo réelle et je vous la livre dans ce fil " +
        "(échafaudage — loi CONTRAINTE-ONDES : le signal d'onde gen3 prendra le relais après distillation). " +
        "Comptez 1 à 4 minutes.",
      provider: "gen3-webgpu",
      model: "gen3-media-engine-v1",
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: messageDirect });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage: messageDirect,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Vidéo courte réaliste via circuit média direct." },
    };
  }

  try {
    const { createVideoProductionJob } = await import("@/lib/video/production-queue");
    // Task 106-a — production OPTIMALE : durée, cadrage, plateforme et
    // formats dérivés sont lus DÉTERMINISTEMENT dans la demande (zéro LLM)
    // et relayés à la file de production (options validées côté pipeline).
    const params = extractVideoParams(promptText);
    const job = await createVideoProductionJob({
      userId: ctx.userId,
      prompt: promptText.trim().slice(0, 4000),
      title: extractVideoTitle(promptText),
      // Task 107-a — la conversation d'origine est PORTÉE PAR LE JOB : à la
      // complétion, le résultat est livré DANS ce fil (message + artefact)
      // même si l'utilisateur a fermé la page.
      conversationId: ctx.conversationId,
      ...(Object.keys(params).length > 0 ? { options: params } : {}),
    });
    const studioUrl = `/studio/video/${job.projectId}`;
    const paramsSummary = [
      params.targetDurationSec ? `durée cible ${Math.floor(params.targetDurationSec / 60) > 0 ? `${Math.floor(params.targetDurationSec / 60)} min ${params.targetDurationSec % 60 || ""}`.trim() : `${params.targetDurationSec} s`}` : null,
      params.aspectRatio ? `cadrage ${params.aspectRatio}` : null,
      params.platform ? `plateforme ${params.platform}` : null,
      params.derivedTargets?.length ? `formats dérivés (${params.derivedTargets.join(", ")})` : null,
      params.subtitlesEnabled === false ? "sans sous-titres" : params.subtitleStyle ? `sous-titres ${params.subtitleStyle === "karaoke_pop" ? "karaoké" : params.subtitleStyle}` : null,
      params.subtitlePosition ? `sous-titres positionnés ${params.subtitlePosition === "top" ? "en haut" : params.subtitlePosition === "center" ? "au centre" : "en bas"}` : null,
      params.effectPreset ? ({ none: "sans effets", subtle: "effets discrets", dynamic: "effets dynamiques", cinematic: "style cinématique", capcut: "studio CapCut" } as Record<string, string>)[params.effectPreset] ?? null : null,
    ].filter(Boolean).join(" · ");
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: [
        "Votre production vidéo est lancée" + (paramsSummary ? ` — ${paramsSummary}.` : "."),
        "Voici ce qui se passe maintenant, étape par étape :",
        "1. Plan du réalisateur et scénario complet (hook, chapitres, scènes, CTA) ;",
        "2. Génération des visuels de chaque scène avec un style cohérent ;",
        "3. Narration vocale, musique (ambiance adaptée) et montage multicam ;",
        "4. Rendu final avec contrôle qualité automatique (durée, audio, sous-titres)",
        params.derivedTargets?.length ? "5. Formats dérivés pour vos plateformes (TikTok/Shorts/Reels…)." : "",
        "",
        "Demandez-moi « où en est ma vidéo ? » à tout moment, ou des modifications (musique, rythme, pause…). Le cadre ci-dessous affiche la progression RÉELLE en temps réel — il se met à jour tout seul jusqu'à la vidéo finie. Le projet complet (timeline, versions, exports) est disponible dans l'atelier vidéo : " + studioUrl,
      ].filter(Boolean).join("\n"),
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "video",
      title: extractVideoTitle(promptText),
      note: "Production vidéo autonome — progression en temps réel",
      videoProjectId: job.projectId,
      videoJobId: job.jobId,
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de production vidéo complète (autopilote lancé)." },
    };
  } catch (error) {
    const unavailable = error instanceof Error && /n.est pas disponible/.test(error.message);
    const message = unavailable
      ? "La production vidéo n'est pas disponible sur cette plateforme actuellement (moteur de production non configuré). Votre demande est conservée : réessayez plus tard ou depuis l'atelier vidéo."
      : "Le lancement de la production vidéo a échoué. Votre demande est conservée — réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de production vidéo complète (échec du lancement)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « artefact application » — page web exécutable + lien d'aperçu */
/* ------------------------------------------------------------------ */
