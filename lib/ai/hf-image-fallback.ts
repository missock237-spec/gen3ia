import "server-only";

import { randomUUID } from "node:crypto";

import { InferenceClient } from "@huggingface/inference";

import { createR2DownloadUrl, isR2Configured, uploadToR2 } from "@/lib/storage/r2";
import { ImageGenerationError, generateImageWithAgnes, type ImageRatio } from "./image-generation";

/**
 * FALLBACK HUGGING FACE — génération d'images Z-Image-Turbo.
 *
 * La structure Hugging Face existante du projet est conservée TELLE QUELLE
 * (lib/memory/embeddings.ts : client officiel @huggingface/inference +
 * HF_TOKEN côté serveur) — ce module lui AJOUTE uniquement la fonction
 * générateur d'images, même schéma de client.
 *
 * ACTIVATION (demande produit) : la génération Hugging Face intervient
 * lorsque le générateur principal (Agnes AI) renvoie un code d'erreur qui
 * empêche la livraison du résultat :
 *   - LIMITE DE CRÉDIT (isAgnesCreditLimitError) : statut HTTP 402 ou
 *     message explicite crédit/quota/solde/billing ;
 *   - INDISPONIBILITÉ TECHNIQUE (isAgnesUnavailableError) : clé absente ou
 *     rejetée (NOT_CONFIGURED, 401/403), panne 5xx, rate-limit 429,
 *     timeout, erreur upstream — Z-Image-Turbo reprend la tâche pour que
 *     la demande de l'utilisateur aboutisse au lieu d'un échec.
 * Les SEULES erreurs sans repli sont les fautes de SAISIE utilisateur
 * (prompt vide/invalide, image source invalide) : le même prompt échouerait
 * pareillement sur le repli.
 *
 * La reprise est AUTOMATIQUE et TRANSPARENTE : generateImageWithFallback
 * rejoue la tâche abandonnée par Agnes sur Z-Image-Turbo et retourne le
 * même contrat que la voie principale (persistance R2 permanente incluse).
 */

export const HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || "Tongyi-MAI/Z-Image-Turbo";

const HF_IMAGE_TIMEOUT_MS = 90_000;

/** Client Hugging Face — même structure que lib/memory/embeddings.ts. */
const client = new InferenceClient(process.env.HF_TOKEN);

/** Le fallback n'est disponible que si le token Hugging Face est configuré. */
export function isHuggingFaceImageEnabled(): boolean {
  return Boolean(process.env.HF_TOKEN);
}

/**
 * Détection déterministe « limite de crédit du générateur principal » :
 *  - statut HTTP 402 (Payment Required) → crédit épuisé, toujours ;
 *  - message fournisseur nommant explicitement le crédit / quota / solde /
 *    billing / épuisement ;
 *  - JAMAIS les pannes transitoires (timeout, 5xx, rate-limit « too many
 *    requests ») : elles ne sont pas une limite de crédit.
 */
export function isAgnesCreditLimitError(error: unknown): boolean {
  if (!(error instanceof ImageGenerationError)) return false;
  if (error.httpStatus === 402) return true;
  if (error.code === "NOT_CONFIGURED" || error.code === "INVALID_PROMPT" || error.code === "INVALID_IMAGE") return false;
  return /(?:cr[ée]dit|solde|balance|quota|insufficient|payment|billing|exhaust|[ée]puis)/i.test(error.message);
}

/**
 * Détection « générateur principal INDISPONIBLE » (extension additive) :
 * la tâche de l'utilisateur ne peut pas aboutir sur Agnes pour une raison
 * TECHNIQUE — crédit épuisé (ci-dessus), clé absente/rejetée, panne 5xx,
 * rate-limit, timeout, erreur upstream. Le repli Hugging Face reprend la
 * tâche pour livrer le résultat au lieu d'un échec.
 * EXCLUSIONS : les fautes de saisie (INVALID_PROMPT / INVALID_IMAGE) — le
 * même prompt échouerait pareillement sur le repli, elles restent des
 * erreurs honnêtes sans génération de secours.
 */
export function isAgnesUnavailableError(error: unknown): boolean {
  if (!(error instanceof ImageGenerationError)) return false;
  if (error.code === "INVALID_PROMPT" || error.code === "INVALID_IMAGE") return false;
  if (isAgnesCreditLimitError(error)) return true;
  if (error.code === "NOT_CONFIGURED" || error.code === "UPSTREAM_ERROR" || error.code === "TIMEOUT") return true;
  if (typeof error.httpStatus === "number") {
    if (error.httpStatus === 401 || error.httpStatus === 403 || error.httpStatus === 408) return true;
    if (error.httpStatus === 429) return true;
    if (error.httpStatus >= 500) return true;
  }
  return false;
}

/** Dimensions Z-Image-Turbo par ratio (multiple de 16, plafond 1280 px). */
export function dimsForRatio(ratio?: ImageRatio | string): { width: number; height: number } {
  switch (ratio) {
    case "16:9":
      return { width: 1280, height: 720 };
    case "9:16":
      return { width: 720, height: 1280 };
    case "4:3":
      return { width: 1152, height: 864 };
    case "3:4":
      return { width: 864, height: 1152 };
    case "3:2":
      return { width: 1216, height: 816 };
    case "2:3":
      return { width: 816, height: 1216 };
    case "21:9":
      return { width: 1280, height: 544 };
    default:
      return { width: 1024, height: 1024 };
  }
}

export interface HuggingFaceImage {
  /** Data URI Base64 de l'image générée (aucune URL temporaire côté HF). */
  dataUri: string;
  contentType: string;
  model: string;
  latencyMs: number;
}

/**
 * Génération RÉELLE d'une image via Hugging Face (Z-Image-Turbo).
 * Le client retourne un Blob binaire — converti en data URI : les couches
 * de persistance du projet (lib/media/persist.ts, engine) consomment déjà
 * ce format (voie 1 « data URI Base64 »).
 */
export async function generateImageWithHuggingFace(options: {
  prompt: string;
  ratio?: ImageRatio | string;
  timeoutMs?: number;
}): Promise<HuggingFaceImage> {
  const prompt = options.prompt?.trim();
  if (!prompt || prompt.length < 3) {
    throw new ImageGenerationError("INVALID_PROMPT", "Décrivez l'image à générer en quelques mots.");
  }
  if (!isHuggingFaceImageEnabled()) {
    throw new ImageGenerationError(
      "NOT_CONFIGURED",
      "Le repli Hugging Face n'est pas configuré sur cette plateforme (HF_TOKEN manquant).",
    );
  }

  const { width, height } = dimsForRatio(options.ratio);
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? HF_IMAGE_TIMEOUT_MS;

  try {
    const blob = (await client.textToImage(
      {
        model: HF_IMAGE_MODEL,
        inputs: prompt,
        parameters: { width, height },
      },
      { signal: AbortSignal.timeout(timeoutMs) },
    )) as Blob;

    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.length === 0) {
      throw new ImageGenerationError("UPSTREAM_ERROR", "Hugging Face n'a pas renvoyé d'image exploitable. Réessayez.");
    }
    const contentType = blob.type?.startsWith("image/") ? blob.type : "image/png";
    return {
      dataUri: `data:${contentType};base64,${buffer.toString("base64")}`,
      contentType,
      model: HF_IMAGE_MODEL,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new ImageGenerationError("TIMEOUT", "La génération Hugging Face a pris trop de temps. Réessayez.");
    }
    throw new ImageGenerationError(
      "UPSTREAM_ERROR",
      error instanceof Error ? error.message : "La génération Hugging Face a échoué.",
    );
  }
}

export type ImageProvider = "agnes" | "huggingface";

export interface FallbackImageResult {
  /** URL affichable : URL signée R2 permanente (repli HF persisté) ou URL Agnes. */
  imageUrl: string;
  model: string;
  latencyMs: number;
  taskId?: string;
  /** Fournisseur ayant RÉELLEMENT produit l'image. */
  provider: ImageProvider;
  /** Clé R2 permanente quand le repli HF a réussi l'archivage. */
  storagePath?: string;
}

/**
 * Génération avec reprise automatique : Agnes AI d'abord (voie principale),
 * et sur erreur de limite de crédit OU d'indisponibilité technique → Hugging
 * Face Z-Image-Turbo reprend la tâche abandonnée. L'image du repli est
 * archivée en R2 PERMANENT (users/<uid>/permanent/ai-images/) avec URL
 * signée ; sans R2, data URI inline si la taille le permet — sinon l'erreur
 * Agnes d'origine est relancée (honnêteté : jamais de promesse non tenable).
 */
export async function generateImageWithFallback(options: {
  prompt: string;
  size?: "1K" | "2K" | "3K" | "4K";
  ratio?: ImageRatio;
  timeoutMs?: number;
  /** Propriétaire de l'archivage permanent (repli HF). */
  userId?: string;
}): Promise<FallbackImageResult> {
  try {
    const image = await generateImageWithAgnes({
      prompt: options.prompt,
      ...(options.size ? { size: options.size } : {}),
      ...(options.ratio ? { ratio: options.ratio } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { ...image, provider: "agnes" };
  } catch (error) {
    if (!isAgnesUnavailableError(error)) throw error;
    if (!isHuggingFaceImageEnabled()) throw error;
    const reason = isAgnesCreditLimitError(error) ? "limite de crédit" : "indisponibilité technique";
    const detail = error instanceof ImageGenerationError ? `${error.code}${error.httpStatus ? ` HTTP ${error.httpStatus}` : ""}` : "erreur";
    console.warn(
      `[hf-image-fallback] Agnes indisponible (${reason} — ${detail}) — reprise automatique sur ${HF_IMAGE_MODEL}`,
    );
  }

  const hf = await generateImageWithHuggingFace({ prompt: options.prompt, ratio: options.ratio, timeoutMs: options.timeoutMs });

  // Archivage permanent R2 (même convention que le chat et l'outil image).
  const userId = typeof options.userId === "string" ? options.userId.trim() : "";
  if (isR2Configured() && userId) {
    try {
      const ext = hf.contentType.includes("jpeg") ? "jpg" : hf.contentType.includes("webp") ? "webp" : "png";
      const key = `users/${userId}/permanent/ai-images/hf-${Date.now()}-${randomUUID()}.${ext}`;
      await uploadToR2(key, Buffer.from(hf.dataUri.split(",")[1] ?? "", "base64"), hf.contentType);
      const url = await createR2DownloadUrl(key, 3600);
      return { imageUrl: url, model: hf.model, latencyMs: hf.latencyMs, provider: "huggingface", storagePath: key };
    } catch (uploadError) {
      console.error("[hf-image-fallback] archivage R2 échoué:", uploadError instanceof Error ? uploadError.message : uploadError);
      // Repli inline ci-dessous (taille bornée) — sinon échec honnête.
    }
  }

  if (hf.dataUri.length <= 500_000) {
    return { imageUrl: hf.dataUri, model: hf.model, latencyMs: hf.latencyMs, provider: "huggingface" };
  }

  throw new ImageGenerationError(
    "UPSTREAM_ERROR",
    "L'image Hugging Face a été générée mais son archivage a échoué (stockage indisponible). Réessayez.",
  );
}
