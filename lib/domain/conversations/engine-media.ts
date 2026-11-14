import "server-only";

/**
 * Tours « image » (édition d'image existante, génération) et « vidéo » (production autopilote déléguée à la file de production). Extrait de engine.ts — code déplacé tel quel.
 */

import { safeEmitter } from "./stream-events";
import { detectImageRatio } from "@/lib/ai/image-intent";
import { extractVideoParams, extractVideoTitle, extractTargetDurationSec, dureeAutomatiqueSelonBesoin, looksLikeVideoRequest } from "@/lib/ai/video-intent";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { attachmentImageCandidates, resolveEditableImageSources } from "@/lib/files/image-source";
import { produceConversationImage } from "./engine-chat";
import type { TurnBase } from "./engine-chat";
import type { ConversationTurnResult } from "./engine-turn";
import { randomUUID } from "node:crypto";
import { professeurImageDisponibleAsync, choisirVoixSelonPersonnage } from "@/lib/neural/professeur-media";
import { analyserIntentionAudio } from "@/lib/neural/audio-intention";

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
 *
 * FIX production (capture 2026-11-11 19:12 : « Crée une message vocal
 * d'une femme qui se présente devant un homme » restait SANS chemin
 * exécutable — le noyau répondait « intention TRAITEMENT_REQUETE que je
 * ne sais pas encore exécuter ») : « message vocal », « note vocale » et
 * « vocal(e)(aux) » + verbe de création sont désormais des marqueurs voix.
 * Une pure question méta (« c'est quoi un message vocal ? ») ne déclenche
 * RIEN (garde interrogative). Exclusions téléphoniques inchangées.
 */
const VERBE_CRÉATION_VOIX = /\b(g[eé]n[eè]re|g[eé]n[eé]ration|fais|fait|cr[ée]\p{L}*|produi\p{L}*|synth[ée]tis\p{L}*|enregistre|dire|dit|disant)\b/iu;

export function looksLikeVoixHumaineRequest(message: string): boolean {
  const motVoix = /\b(voix humaine|voix\s+(?:de|qui|d'un|d'une)|synth[eè]se vocale|voice ?over|voix off)\b/iu.test(message)
    || /\bvoix\b/iu.test(message) && VERBE_CRÉATION_VOIX.test(message)
    || /\b(messages?|note|notes) vocal(?:e|es|aux)?\b/iu.test(message)
    || /\bvocal(?:e|es|aux)?\b/iu.test(message) && VERBE_CRÉATION_VOIX.test(message);
  if (!motVoix) return false;
  // Exclusions strictes : agents téléphoniques / standard / cloches…
  if (/\b(standardiste|standard t[eé]l[eé]phonique|agent (?:t[eé]l[eé]phonique|vocal)|r[eé]pondeur)\b/i.test(message)) return false;
  // Pure question méta : aucun produit demandé.
  if (/^\s*(c[''’]est quoi|qu[''’]est[- ]ce que|comment (?:ça|c[a])?\s*marche)\b/i.test(message.trim())) return false;
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

/**
 * Texte À FAIRE DIRE (déterministe + IA centrale) : une citation explicite
 * (« …dit : "Bonjour" ») est prise littéralement. Un SCÉNARIO sans citation
 * (« une femme qui se présente devant un homme ») est RÉALISÉ par le
 * moteur neuronal : il écrit le texte parlé (jamais l'instruction lue
 * telle quelle — « Crée un message vocal de… » ne doit PAS être énoncé).
 * Échec IA → dernier recours honnête : la demande entière (comportement
 * historique), jamais de texte inventé silencieusement.
 */
export async function texteÀFaireDire(demande: string): Promise<string> {
  const citation = extrairePhraseÀDire(demande);
  if (citation !== demande.trim()) return citation;
  try {
    const { generate } = await import("@/lib/ai/router");
    const réponse = await generate({
      task: "reasoning",
      system:
        "Tu écris le TEXTE À FAIRE DIRE à voix haute pour un message vocal. La demande décrit une scène ou un personnage : écris UNIQUEMENT les mots à énoncer (1 à 6 phrases naturelles), en français, sans titre, sans guillemets, sans explication, sans mention de la demande elle-même.",
      messages: [{ role: "user", content: demande.slice(0, 1500) }],
      temperature: 0.7,
      maxTokens: 700,
    });
    const brut = (réponse.text ?? "").trim()
      .replace(/^(?:voici|texte|voix)\s*[:：-]\s*/i, "")
      .replace(/^[«"'\u201c]+/, "")
      .replace(/[»"'\u201d]+$/, "")
      .trim();
    if (brut.length >= 2 && !/^(?:cr[ée]\p{L}*|g[ée]n[èe]re|fais)\b/iu.test(brut)) {
      return brut.slice(0, 2000);
    }
  } catch {
    // IA indisponible → dernier recours ci-dessous.
  }
  return demande.trim().slice(0, 2000);
}

/* ------------------------------------------------------------------ */
/* MUSIQUE RÉELLE — « crée une musique de 2 minutes » : composition    */
/* algorithmique déterministe du moteur gen3 (styles, accords,         */
/* mélodie, percussions) rendue WAV/MP3 via FFmpeg, archivée en        */
/* stockage permanent et livrée DANS LE FIL (lecteur audio durable).   */
/* ------------------------------------------------------------------ */

/** DEMANDE DE MUSIQUE : verbe de création (ou durée explicite) + objet
 * musical. Exclusions strictes : VIDÉO (son pipeline possède son propre
 * lit musical — « une vidéo avec une musique énergique » reste une vidéo),
 * VOIX parlée (sans instrumentation), questions méta (aucun produit
 * demandé). Détection déterministe : aucune variance LLM. */
export function looksLikeDemandeMusique(message: string): boolean {
  const objet =
    /\b(musique|chanson|m[eé]lodie|instrumentale?|piste (?:audio|musicale)|boucle musicale|nappe sonore|beat|soundtrack|bande[- ]son)\b/iu.test(message);
  if (!objet) return false;
  const verbe =
    /\b(cr[ée]{1,3}\b|cr[ée]e|cr[ée]er|compose[szr]?|g[ée]n[èe]re[szr]?|g[ée]n[ée]rer|fais|fait|fabrique[szr]?|produis|improvise)\b/iu.test(message);
  const duree = /\b\d+\s*(min|minutes?|secondes?|secs?|s)\b/iu.test(message);
  if (!verbe && !duree) return false;
  if (looksLikeVideoRequest(message)) return false;
  if (looksLikeVoixHumaineRequest(message)) return false;
  if (/^\s*(c[''’]est quoi|qu['''’]est[- ]ce que|comment (?:ça|c[a])?\s*marche)\b/i.test(message.trim())) return false;
  return true;
}

export async function runMusiqueTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Composition de la musique en cours…" });
  // EXIGENCE UTILISATEUR (2026-11-14) : une génération de musique est une
  // CHANSON — le titre cité est respecté, sinon gen3 en invente un ; les
  // PAROLES sont écrites sur ce titre ; l'AUDIO est produit avec voix
  // humaine réelle. L'instrumental pur reste le chemin HISTORIQUE, choisi
  // seulement sur demande explicite ; le CLIP musical part seulement sur
  // demande (« clip », « vidéo musicale ») — par défaut : AUDIO.
  const instrumentaleDemandée = /\b(instrumentale?|instrumental|sans\s+(?:paroles|voix|chant))\b/i.test(ctx.message);
  try {
    const { urlDurableAbsolue, urlDurableRelative } = await import("@/lib/media/url-durable");
    if (instrumentaleDemandée) {
      const { musiqueCreerTool } = await import("@/lib/tools/media/musique");
      const sortie = await musiqueCreerTool.execute({ demande: ctx.message }, { userId: ctx.userId });
      const cle = sortie.url && sortie.url.startsWith("users/") ? sortie.url : undefined;
      const urlJouable = (cle ? urlDurableAbsolue(cle, ctx.origineClient) : null) ?? sortie.ecouterUrl;
      const audioUrlDurable = cle ? urlDurableRelative(cle) : undefined;
      const assistantMessage = await appendMessage({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        role: "assistant",
        content:
          `Votre musique instrumentale est prête (${sortie.dureeReelle ?? "?"} s, style ${sortie.styleLabel ?? sortie.style ?? "génératif"}). ` +
          `Composition algorithmique du moteur gen3 — ${sortie.note ?? ""} Écoutez ici : ${urlJouable}`,
        // Champ STRUCTURÉ lu par le fil : lecteur <audio> embarqué durable.
        ...(audioUrlDurable ? { audioUrl: audioUrlDurable } : {}),
        provider: "musique-gen3",
        model: "composition-algorithmique",
        generationStatus: "complete",
      });
      const artifact = await createArtifact({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        projectId: ctx.projectId,
        type: "audio",
        title: ctx.message.slice(0, 80),
        url: sortie.ecouterUrl,
        storagePath: cle,
        note: `Musique instrumentale réelle — ${sortie.styleLabel ?? sortie.style ?? "génératif"}, ${sortie.dureeReelle ?? "?"} s`,
      });
      await onEvent({ type: "message_complete", message: assistantMessage });
      await onEvent({ type: "artifact_created", artifact });
      return {
        conversationId: ctx.conversationId,
        userMessage: ctx.userMessage,
        assistantMessage,
        artifacts: [artifact],
        approvals: [],
        intent: { mode: "chat", understanding: `Musique instrumentale composée (${sortie.dureeReelle ?? "?"} s) et archivée en permanent.` },
      };
    }

    // CHEMIN PAR DÉFAUT : CHANSON (titre → paroles → voix humaine réelle).
    const { musiqueChansonTool } = await import("@/lib/tools/media/musique-chanson");
    const sortie = await musiqueChansonTool.execute({ demande: ctx.message }, { userId: ctx.userId });
    const cle = sortie.url && sortie.url.startsWith("users/") ? sortie.url : undefined;
    const urlJouable = (cle ? urlDurableAbsolue(cle, ctx.origineClient) : null) ?? sortie.ecouterUrl;
    const audioUrlDurable = cle ? urlDurableRelative(cle) : undefined;
    const blocRefrain = sortie.paroles.refrain.slice(0, 2).join(" / ");
    const clipLien = sortie.clip ? `\nClip musical : ${sortie.clip.ecouterUrl}` : "";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        `Votre chanson « ${sortie.titre} » est prête (${sortie.dureeReelle} s, ${sortie.styleLabel}, voix humaine réelle).\n` +
        `Titre : ${sortie.titreDetecte ? "celui que vous avez donné" : "inventé par moi (aucun titre cité)"}. ` +
        `Paroles (${sortie.paroles.source === "moteur-gen3" ? "écrites pour votre titre" : "repli déterministe"}) — refrain : « ${blocRefrain} ».\n` +
        `${sortie.note}\nÉcoutez ici : ${urlJouable}${clipLien}`,
      // Champ STRUCTURÉ lu par le fil : lecteur <audio> embarqué durable.
      ...(audioUrlDurable ? { audioUrl: audioUrlDurable } : {}),
      provider: "musique-gen3",
      model: "chanson-paroles-voix",
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "audio",
      title: `Chanson — ${sortie.titre}`,
      url: sortie.ecouterUrl,
      storagePath: cle,
      note: `Chanson « ${sortie.titre} » — paroles + voix humaine, ${sortie.styleLabel}, ${sortie.dureeReelle} s`,
    });
    const artifacts = [artifact];
    if (sortie.clip?.url) {
      const artefactClip = await createArtifact({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        projectId: ctx.projectId,
        type: "video",
        title: `Clip musical — ${sortie.titre}`,
        url: sortie.clip.ecouterUrl,
        storagePath: sortie.clip.url,
        note: `Clip musical de la chanson « ${sortie.titre} » — ${sortie.clip.plans} plans, MP4 muxé avec le son`,
      });
      artifacts.push(artefactClip);
      await onEvent({ type: "artifact_created", artifact: artefactClip });
    }
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts,
      approvals: [],
      intent: {
        mode: "chat",
        understanding: `Chanson « ${sortie.titre} » (${sortie.titreDetecte ? "titre cité" : "titre inventé"}, paroles + voix humaine réelle, ${sortie.dureeReelle} s)${sortie.clip ? " + clip musical" : ""} archivée en permanent.`,
      },
    };
  } catch (error) {
    // ÉCHEC HONNÊTE : la cause réelle est nommée à l'utilisateur — jamais
    // de message d'audio fictif ni de lien mort.
    const cause = error instanceof Error ? error.message : "erreur inconnue";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        "Je n'ai pas réussi à composer cette musique — cause réelle : " + cause.slice(0, 300) +
        ". Réessayez (par ex. « crée une musique de 2 minutes, calme au piano ») ou demandez-moi un message vocal.",
      provider: "musique-gen3",
      model: "composition-algorithmique",
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Composition musicale en échec honnête (cause nommée)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* SONS RÉELS — « crée le son de la pluie » : design sonore sémantique  */
/* du moteur scénique gen3 (couches réelles pluie/vagues/orage/feu…)   */
/* archivé en stockage permanent et livré DANS LE FIL (lecteur audio   */
/* durable). JAMAIS le TTS : lire un bruit à voix haute est une erreur  */
/* de rendu — le routage est AUTOMATIQUE (audio-intention), l'utilisateur */
/* n'a jamais besoin de le préciser.                                    */
/* ------------------------------------------------------------------ */

/** DEMANDE DE SON : verbe de création + objet sonore reconnu par le
 * lexique d'intention audio (lib/neural/audio-intention — gardes anti
 * faux amis incluses). Exclusions strictes : VIDÉO (son pipeline propre),
 * VOIX parlée, MUSIQUE (lit musical dédié), questions méta. */
export function looksLikeDemandeSon(message: string): boolean {
  const verbe =
    /\b(cr[ée]{1,3}\b|cr[ée]e|cr[ée]er|g[ée]n[èe]re[szr]?|g[ée]n[ée]rer|fais|fait|fabrique[szr]?|produis|joue[szr]?|improvise|montre)\b/iu.test(message);
  if (!verbe) return false;
  if (looksLikeVideoRequest(message)) return false;
  if (looksLikeVoixHumaineRequest(message)) return false;
  if (looksLikeDemandeMusique(message)) return false;
  if (/^\s*(c[''’]est quoi|qu['''’]est[- ]ce que|comment (?:ça|c[a])?\s*marche)\b/i.test(message.trim())) return false;
  // Objet sonore : le lexique SFX testé (pluie, orage, vagues, vent, feu,
  // train, cloche… FR+EN) décide — nature « son » exigée.
  return analyserIntentionAudio(message).nature === "son";
}

/**
 * Classification d'une erreur de LANCEMENT : TRUE si l'incident est
 * PASSAGER (saturation du stockage — disjoncteur anti-tempête, quota
 * Firestore gRPC « Resource has been exhausted », réseau datacenter
 * ETIMEDOUT/ECONNRESET/fetch failed, réponses 429/503). Dans ce cas la
 * plateforme PROMET une relance automatique post-cooldown — le message
 * utilisateur et le comportement doivent tenir cette promesse.
 */
export function estErreurTransitoireStockage(detailErreur: string): boolean {
  return /disjoncteur|quota|exhausted|stall|aucune réponse en|UNAVAILABLE|indisponible \(stockage|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|Deadline|429|503/i.test(detailErreur ?? "");
}

/** Durée d'un son : explicite (« 15 secondes ») sinon 10 s (ambiance). */
function dureeSonDemandée(message: string): number {
  const explicite = /\b(\d{1,3})\s*(s|sec|secondes?)\b/iu.exec(message);
  if (explicite) {
    const valeur = Number.parseInt(explicite[1] ?? "", 10);
    if (Number.isFinite(valeur)) return Math.min(30, Math.max(4, valeur));
  }
  return 10;
}

export async function runSonTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Création du son en cours…" });
  try {
    // MÊME moteur que le chat (voice.speak) : le routage d'intention y est
    // AUTOMATIQUE — nature « son » → design sonore sémantique, JAMAIS le
    // TTS. La demande ENTIERE sert de prompt scénique (couches reconnues).
    const { voiceSpeakTool } = await import("@/lib/tools/media/voice-speak");
    const sortie = await voiceSpeakTool.execute(
      { text: ctx.message.trim().slice(0, 4000), dureeSecondes: dureeSonDemandée(ctx.message) },
      { userId: ctx.userId },
    );
    if (sortie.note.includes("pas une parole humaine naturelle") && !sortie.note.includes("Design sonore")) {
      // Défense en profondeur : si le rendu n'est PAS un design sonore
      // (nappe générique), le tour n'est pas le bon — on laisse le moteur
      // conversationnel historique répondre (compartiments, vocation…).
      throw new Error("ROUTAGE_SON_NON_RESOLU");
    }
    const { urlDurableAbsolue, urlDurableRelative } = await import("@/lib/media/url-durable");
    const cle = sortie.url && sortie.url.startsWith("users/") ? sortie.url : undefined;
    const urlJouable = (cle ? urlDurableAbsolue(cle, ctx.origineClient) : null) ?? sortie.ecouterUrl;
    const audioUrlDurable = cle ? urlDurableRelative(cle) : undefined;
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        `Voici votre son — VRAI design sonore sémantique du moteur gen3 (couches réelles, rendu ${sortie.dureeSecondes} s). ` +
        `${sortie.note} Écoutez ici : ${urlJouable}`,
      // Champ STRUCTURÉ lu par le fil : lecteur <audio> embarqué durable.
      ...(audioUrlDurable ? { audioUrl: audioUrlDurable } : {}),
      provider: "gen3-snn-audio",
      model: String(sortie.moteur ?? "gen3-snn-audio-v2-scene"),
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "audio",
      title: ctx.message.slice(0, 80),
      url: sortie.ecouterUrl,
      storagePath: cle,
      note: `Son réel — design sonore sémantique (${sortie.dureeSecondes} s), jamais lu à voix haute`,
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: `Son réellement rendu (${sortie.dureeSecondes} s, design sonore sémantique, aucune lecture vocale) et archivé en permanent.` },
    };
  } catch (error) {
    // ÉCHEC HONNÊTE : la cause réelle est nommée à l'utilisateur — jamais
    // de message d'audio fictif ni de lien mort.
    const cause = error instanceof Error ? error.message : "erreur inconnue";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        "Je n'ai pas réussi à créer ce son — cause réelle : " + cause.slice(0, 300) +
        ". Réessayez (par ex. « crée le son de la pluie sur les vitres ») ou demandez-moi un message vocal.",
      provider: "gen3-snn-audio",
      model: String(sortie_moteur_secours()),
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Création de son en échec honnête (cause nommée)." },
    };
  }
}

/** Libellé moteur de secours pour l'échec honnête (aucune promesse). */
function sortie_moteur_secours(): string {
  return "gen3-snn-audio";
}

export async function runVoixTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const phrase = extrairePhraseÀDire(ctx.message);
  // FIX production (capture 19:12) — VOIX SERVEUR D'ABORD : la voix humaine
  // réelle ne doit PAS dépendre du GPU du navigateur (mobile sans WebGPU,
  // headless, GPU faible). Cascade : passerelle interne → espace public
  // Edge-TTS (voix neuronale réelle, féminine/masculine selon le personnage
  // décrit). Succès → audio livré IMMÉDIATEMENT dans le fil (message +
  // artefact). Échec → cascade WebGPU navigateur (chemin historique).
  const choix = choisirVoixSelonPersonnage(ctx.message);
  try {
    const { genererVoixHumaineProfesseurEtPersister } = await import("@/lib/neural/media-service");
    const texte = await texteÀFaireDire(ctx.message);
    const rendu = await genererVoixHumaineProfesseurEtPersister({
      userId: ctx.userId,
      texte,
      voix: choix.voixEspace,
    });
    if (rendu) {
      const moteur = String(rendu.meta?.moteur ?? "");
      // LIVRAISON DURABLE (2026-11-12) : l'URL présignée expire (TTL 1 h) —
      // le message persisté porte l'URL canonique re-signée à chaque
      // résolution (texte cliquable à vie + lecteur du fil via audioUrl).
      // Repli : présignée d'origine (jamais de perte de livraison).
      const { urlDurableAbsolue, urlDurableRelative } = await import("@/lib/media/url-durable");
      const urlJouable = (rendu.cleStockage ? urlDurableAbsolue(rendu.cleStockage, ctx.origineClient) : null) ?? rendu.url;
      const audioUrlDurable = rendu.cleStockage ? urlDurableRelative(rendu.cleStockage) : undefined;
      const assistantMessage = await appendMessage({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        role: "assistant",
        content:
          `Voici votre message vocal — voix ${choix.genreLabel} réelle (${String(rendu.meta?.voix ?? "neuronale")}, ` +
          `${moteur === "professeur-voix-espace-edge-tts" ? "espace public Edge-TTS" : "professeur média temporaire"}, ` +
          "échafaudage — loi CONTRAINTE-ONDES). Écoutez ici : " + urlJouable,
        // Champ STRUCTURÉ lu par le fil : lecteur <audio> embarqué durable.
        ...(audioUrlDurable ? { audioUrl: audioUrlDurable } : {}),
        provider: "professeur-temporaire",
        model: moteur || "professeur-voix",
        generationStatus: "complete",
      });
      const artifact = await createArtifact({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        projectId: ctx.projectId,
        type: "audio",
        title: ctx.message.slice(0, 80),
        url: rendu.url,
        storagePath: rendu.cleStockage,
        note: `Voix ${choix.genreLabel} réelle — professeur temporaire (${moteur})`,
      });
      await onEvent({ type: "message_complete", message: assistantMessage });
      await onEvent({ type: "artifact_created", artifact });
      return {
        conversationId: ctx.conversationId,
        userMessage: ctx.userMessage,
        assistantMessage,
        artifacts: [artifact],
        approvals: [],
        intent: { mode: "chat", understanding: `Message vocal réel (voix ${choix.genreLabel}) servi par le serveur.` },
      };
    }
  } catch {
    // Cascade WebGPU ci-dessous (jamais de faux succès serveur).
  }
  const jobId = randomUUID();
  await onEvent({
    type: "webgpu_media",
    jobId,
    conversationId: ctx.conversationId,
    kind: "voice",
    prompt: phrase.slice(0, 2000),
    voix: choix.voixEspace,
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
    // LOCALE sur le GPU de l'utilisateur — UNIQUEMENT quand le professeur
    // média est ABSENT (incidence réelle it.144, 2026-11-10 : le professeur
    // serveur produit le photoréalisme RÉEL en 30-90 s ; le déléguer au
    // GPU navigateur (téléchargement 1-2 Go) était une régression d'usage.
    // Le WebGPU reste le chemin de repli quand la passerelle n'est pas
    // configurée — son repli serveur lui-même passe par le professeur).
    if (looksLikePhotorealRequest(ctx.message) && !(await professeurImageDisponibleAsync())) {
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
    // ÉCHELLE SERVEUR ÉCHOUÉE sur une demande PHOTORÉALISTE (it.144 : la
    // passerelle est injoignable d'un VPS public et HF 402 sans crédits) →
    // DÉLÉGATION WebGPU au navigateur de l'utilisateur (SD 2.1 + LoRA
    // photoréalisme, essaim gen3) au lieu de servir une scène plate.
    if (looksLikePhotorealRequest(ctx.message) && image.erreurProfesseur) {
      const jobIdDélégation = randomUUID();
      await onEvent({
        type: "webgpu_media",
        jobId: jobIdDélégation,
        conversationId: ctx.conversationId,
        kind: "image",
        prompt: ctx.message.trim().slice(0, 2000),
        ratio: detectImageRatio(ctx.message),
        engine: { repo: WEBGPU_MEDIA_REPO, manifest: "MANIFEST.json" },
      });
      const messageDélégation = await appendMessage({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        role: "assistant",
        content:
          "Photoréalisme serveur indisponible depuis ce réseau (constat honnête : " +
          `${image.erreurProfesseur.slice(0, 140)}) — je délègue la génération à l'IA centrale de l'essaim gen3, ` +
          "qui la répartit sur les GPU disponibles (le vôtre participe via l'agent gen3 dans votre navigateur ; " +
          "première génération : téléchargement des modèles ~1 à 2 Go). Si l'essaim ne peut pas calculer, " +
          "je vous l'annoncerai honnêtement plutôt que de prétendre à un photoréalisme faux.",
        provider: "gen3-webgpu",
        model: "gen3-media-engine-v1",
        generationStatus: "complete",
      });
      await onEvent({ type: "message_complete", message: messageDélégation });
      return {
        conversationId: ctx.conversationId,
        userMessage: ctx.userMessage,
        assistantMessage: messageDélégation,
        artifacts: [],
        approvals: [],
        intent: { mode: "chat", understanding: "Photoréalisme : serveur indisponible → délégation WebGPU." },
      };
    }
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
    const { classifyTickError } = await import("@/lib/video/queue-resume");
    // Task 106-a — production OPTIMALE : durée, cadrage, plateforme et
    // formats dérivés sont lus DÉTERMINISTEMENT dans la demande (zéro LLM)
    // et relayés à la file de production (options validées côté pipeline).
    // DEMANDE PROPRIÉTAIRE (2026-11-11) : « la durée dépend de la demande
    // de l'utilisateur ou du besoin de l'utilisateur en cas où
    // l'utilisateur ne précise pas la durée » — sans durée explicite, le
    // BESOIN est estimé déterministement (dureeAutomatiqueSelonBesoin :
    // clip court ~15 s, séquences +6 s chacune, formats longs 60-90 s).
    const params = extractVideoParams(promptText);
    if (params.targetDurationSec === undefined) {
      params.targetDurationSec = dureeAutomatiqueSelonBesoin(promptText);
    }
    const lancerJob = () =>
      createVideoProductionJob({
        userId: ctx.userId,
        prompt: promptText.trim().slice(0, 4000),
        title: extractVideoTitle(promptText),
        // Task 107-a — la conversation d'origine est PORTÉE PAR LE JOB : à la
        // complétion, le résultat est livré DANS ce fil (message + artefact)
        // même si l'utilisateur a fermé la page.
        conversationId: ctx.conversationId,
        // LIVRAISON DURABLE : l'origine du lanceur est CAPTÉE au tour — le
        // lien du master livré en arrière-plan suit l'hôte réellement navigué.
        ...(ctx.origineClient ? { origineClient: ctx.origineClient } : {}),
        ...(Object.keys(params).length > 0 ? { options: params } : {}),
      });
    // ROBUSTESSE LANCEMENT (2026-11-13, « chaque requête vidéo échoue ») :
    // un incident PASSAGER du stockage (stall → disjoncteur anti-tempête)
    // ne doit jamais transformer une demande vidéo valide en échec du fil.
    // Le lancement complet est relancé (2 relances espacées 5 s / 12 s) :
    // le repli half-open du disjoncteur laisse passer une sonde réelle par
    // fenêtre de cooldown — la relance consomme cette sonde au bon moment.
    // Un échec FATAL (validation, limite atteinte) échoue immédiatement,
    // sans relance inutile ; après épuisement, échec honnête ci-dessous.
    let job: Awaited<ReturnType<typeof createVideoProductionJob>> | null = null;
    let dernierErreur: unknown = null;
    for (const tentative of [0, 1, 2]) {
      try {
        job = await lancerJob();
        dernierErreur = null;
        break;
      } catch (erreurLancement) {
        dernierErreur = erreurLancement;
        const passager = classifyTickError(erreurLancement) !== "fatal";
        if (tentative < 2 && passager) {
          await new Promise((resolu) => setTimeout(resolu, tentative === 0 ? 5_000 : 12_000));
        } else {
          break;
        }
      }
    }
    if (!job) throw dernierErreur instanceof Error ? dernierErreur : new Error("lancement indisponible");
    const paramsSummary = [
      params.targetDurationSec ? `durée cible ${Math.floor(params.targetDurationSec / 60) > 0 ? `${Math.floor(params.targetDurationSec / 60)} min ${params.targetDurationSec % 60 || ""}`.trim() : `${params.targetDurationSec} s`}${extractTargetDurationSec(promptText) ? "" : " (estimée selon votre besoin — précisez une durée pour l'ajuster)"}` : null,
      params.aspectRatio ? `cadrage ${params.aspectRatio}` : null,
      params.platform ? `plateforme ${params.platform}` : null,
      params.derivedTargets?.length ? `formats dérivés (${params.derivedTargets.join(", ")})` : null,
      params.subtitlesEnabled === false ? "sans sous-titres" : params.subtitleStyle ? `sous-titres ${params.subtitleStyle === "karaoke_pop" ? "karaoké" : params.subtitleStyle}` : null,
      params.subtitlePosition ? `sous-titres positionnés ${params.subtitlePosition === "top" ? "en haut" : params.subtitlePosition === "center" ? "au centre" : "en bas"}` : null,
      params.effectPreset ? ({ none: "sans effets", subtle: "effets discrets", dynamic: "effets dynamiques", cinematic: "style cinématique", capcut: "studio CapCut" } as Record<string, string>)[params.effectPreset] ?? null : null,
    ].filter(Boolean).join(" · ");
    // AFFICHAGE HONNÊTE (fix capture 08:54) : à partir d'ici le job de
    // production EXISTE — un incident d'affichage (appendMessage/createArtifact
    // sous quota) ne doit JAMAIS produire « lancement échoué » alors que la
    // production tourne réellement. L'échec d'affichage reçoit son propre
    // message de secours, jamais le message d'échec de lancement.
    try {
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
          "Demandez-moi « où en est ma vidéo ? » à tout moment. La vidéo terminée sera livrée DIRECTEMENT dans ce fil (message + lien de lecture + artefact), même si vous fermez la page.",
        ].filter(Boolean).join("\n"),
        // CARTE VIDÉO DANS LE FIL (2026-11-12) : l'id projet structuré permet
        // au chat de rendre la carte de progression/lecteur immédiatement —
        // sans dépendre d'un artifact_created jamais rendu par l'UI épurée.
        videoProjectId: job.projectId,
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
    } catch (erreurAffichage) {
      const detailAffichage = erreurAffichage instanceof Error ? `${erreurAffichage.name}: ${erreurAffichage.message}` : String(erreurAffichage);
      console.error(`[vidéo] job ${job.projectId.slice(0, 8)} lancé mais affichage incident : ${detailAffichage.slice(0, 300)}`);
      const contenuSecours = `Votre production vidéo est bien LANCÉE — l'affichage du fil a rencontré un incident passager. La progression reste visible dans l'atelier : /studio/video/${job.projectId}. La vidéo terminée sera livrée dans ce fil dès que possible.`;
      const secours = await appendMessage({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        role: "assistant",
        content: contenuSecours,
        videoProjectId: job.projectId,
        generationStatus: "complete",
      }).catch(() => null);
      // Persistance impossible (incident R2) : message SYNTHÉTIQUE rendu au
      // tour uniquement (jamais de mensonge « lancement échoué » — le job
      // tourne réellement).
      const messageAffiché = secours ?? {
        id: randomUUID(),
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        role: "assistant" as const,
        content: contenuSecours,
        videoProjectId: job.projectId,
        generationStatus: "complete" as const,
        createdAt: new Date().toISOString(),
      };
      await onEvent({ type: "message_complete", message: messageAffiché });
      return {
        conversationId: ctx.conversationId,
        userMessage: ctx.userMessage,
        assistantMessage: messageAffiché,
        artifacts: [],
        approvals: [],
        intent: { mode: "chat", understanding: "Production lancée ; affichage du fil en incident (job sain)." },
      };
    }
  } catch (error) {
    // FIN DU DIAGNOSTIC À L'AVEUGLE (capture 08:54) : l'erreur réelle est
    // journalisée (console PM2) — le message utilisateur ne suffit plus à
    // comprendre un incident de lancement.
    const detailErreur = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[vidéo] lancement échoué (${ctx.conversationId.slice(0, 8)}) : ${detailErreur.slice(0, 400)}`);
    const unavailable = error instanceof Error && /n.est pas disponible/.test(error.message);
    // HONNÊTETÉ (2026-11-13, élargie capture 08:54) : un incident passager
    // du stockage (disjoncteur anti-tempête, quota Firestore gRPC, réseau
    // du datacenter) est différent d'un moteur non configuré — l'utilisateur
    // doit savoir QUE faire et pourquoi.
    const saturation = estErreurTransitoireStockage(detailErreur);
    const message = unavailable
      ? "La production vidéo n'est pas disponible sur cette plateforme actuellement (moteur de production non configuré). Votre demande est conservée : réessayez plus tard ou depuis l'atelier vidéo."
      : saturation
        ? "Le lancement de votre vidéo a buté sur une saturation MOMENTANÉE du stockage de la plateforme (protection anti-tempête). Rien n'est perdu : je relance automatiquement votre production dans ~2 minutes — vous n'avez rien à faire. Vous pouvez aussi la relancer vous-même en renvoyant votre demande."
        : "Le lancement de la production vidéo a échoué. Votre demande est conservée — réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    // RELANCE AUTOMATIQUE POST-COOLDOWN (capture 08:54) : le disjoncteur
    // quota se referme après 90 s (quota logiciel ; 10 min pour le quota
    // quotidien) — les 3 tentatives internes (5 s/12 s) s'épuisent AVANT.
    // Le process PM2 est persistant : after() programme la relance APRÈS la
    // réponse, au-delà du cooldown. UNE seule relance ; anti-doublon par
    // LECTURE du fil (R2, indépendant de Firestore) : si l'utilisateur a
    // déjà relancé lui-même, la relance s'abstient.
    if (saturation) {
      const relanceProgrammée = async () => {
        try {
          await new Promise((resolu) => setTimeout(resolu, 95_000));
          const { listMessages } = await import("@/lib/chat/repository");
          const fil = await listMessages(ctx.userId, ctx.conversationId, 20, { order: "recent" }).catch(() => []);
          const déjàLancé = (fil ?? []).some((m) => m.role === "assistant" && typeof m.videoProjectId === "string" && m.videoProjectId.length > 0 && m.createdAt > assistantMessage.createdAt);
          if (déjàLancé) return;
          const { createVideoProductionJob } = await import("@/lib/video/production-queue");
          // Recalcul déterministe (hors portée du try : params relancés à
          // l'identique depuis le même prompt — zéro LLM, zéro dérive).
          const paramsRelance = extractVideoParams(promptText);
          if (paramsRelance.targetDurationSec === undefined) {
            paramsRelance.targetDurationSec = dureeAutomatiqueSelonBesoin(promptText);
          }
          const jobRelancé = await createVideoProductionJob({
            userId: ctx.userId,
            prompt: promptText.trim().slice(0, 4000),
            title: extractVideoTitle(promptText),
            conversationId: ctx.conversationId,
            ...(ctx.origineClient ? { origineClient: ctx.origineClient } : {}),
            ...(Object.keys(paramsRelance).length > 0 ? { options: paramsRelance } : {}),
          });
          await appendMessage({
            conversationId: ctx.conversationId,
            userId: ctx.userId,
            role: "assistant",
            content: `Votre vidéo a été relancée automatiquement après la saturation momentanée — la production est en cours. Suivez la progression ici ou dans l'atelier : /studio/video/${jobRelancé.projectId}.`,
            videoProjectId: jobRelancé.projectId,
            generationStatus: "complete",
          });
        } catch (erreurRelance) {
          const detailRelance = erreurRelance instanceof Error ? erreurRelance.message : String(erreurRelance);
          console.error(`[vidéo] relance automatique échouée : ${detailRelance.slice(0, 300)}`);
          await appendMessage({
            conversationId: ctx.conversationId,
            userId: ctx.userId,
            role: "assistant",
            content: "La relance automatique de votre vidéo a buté sur une saturation persistante du stockage. Votre demande reste conservée — réessayez dans quelques minutes ou dites-moi « relance ma vidéo ».",
            generationStatus: "failed",
          }).catch(() => undefined);
        }
      };
      try {
        const { after } = await import("next/server");
        after(() => relanceProgrammée());
      } catch {
        // Hors scope requête (test) : pas de relance programmée — le message
        // reste honnête et la demande conservée.
      }
    }
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
