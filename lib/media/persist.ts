import { randomUUID } from "node:crypto";

import {
  createR2DownloadUrl,
  isR2Configured,
  uploadToR2,
} from "@/lib/storage/r2";

/**
 * Persistance des images générées par l'outil agent (Task 103-a, audit
 * production du 2026-10-07).
 *
 * Constat : l'outil image.generate retournait l'URL TEMPORAIRE d'Agnes —
 * contrairement au chat (lib/domain/conversations/engine.ts,
 * produceConversationImage) qui copie chaque image en stockage permanent
 * R2, l'image livrée par l'outil agent disparaissait à l'expiration de
 * l'URL provider.
 *
 * Ce module partage la logique de copie : téléchargement de l'image
 * (URL https provider OU data URI Base64) puis upload R2 sous le chemin
 * PERMANENT standard de l'application :
 *
 *   users/<uid>/permanent/ai-images/<horodatage>-<uuid>.<ext>
 *
 * (même convention de clé que le chat — résolvable par
 * /api/storage/permanent?path=… et la bibliothèque de fichiers).
 *
 * Contrat de dégradation gracieuse (parité avec le chat) : cette fonction
 * ne lève JAMAIS — en cas d'échec (réseau, taille, R2 non configuré,
 * upload en erreur), elle retourne l'URL d'origine avec storage:"provider"
 * au lieu de faire échouer une génération pourtant réussie.
 */

/** Timeout du téléchargement provider (Agnes 4K réel : quelques Mo). */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Limite de taille d'une image générée re-hébergée (au-delà : repli
 * provider — on ne copie pas un objet aberrant en stockage permanent).
 */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Fenêtre de l'URL signée renvoyée pour la copie permanente. L'OBJET R2 ne
 * expire jamais (chemin « permanent », même règle que les fichiers de
 * l'utilisateur) ; seule l'URL signée d'accès direct a une fenêtre courte —
 * le handle durable est storagePath, re-résolvable à volonté via
 * /api/storage/permanent?path=…
 */
const SIGNED_URL_TTL_S = 3600;

/** Sous-dossier par défaut sous users/<uid>/permanent/ (parité chat). */
const DEFAULT_PREFIX = "ai-images";

export interface PersistGeneratedImageParams {
  /** Propriétaire de la copie (l'image est isolée sous son espace R2). */
  userId: string;
  /**
   * Source de l'image : URL https renvoyée par le provider (Agnes,
   * temporaire) OU data URI Base64 déjà en main.
   */
  imageUrl: string;
  /** Sous-dossier sous users/<uid>/permanent/ (défaut : ai-images). */
  prefix?: string;
}

export interface PersistedImage {
  /**
   * URL à donner à l'utilisateur : URL signée de la copie PERMANENTE quand
   * la copie R2 a réussi, sinon l'URL d'origine (provider ou data URI).
   */
  url: string;
  /** "r2" = copie permanente réussie ; "provider" = repli (URL d'origine). */
  storage: "r2" | "provider";
  /**
   * Handle durable : clé R2 complète (users/<uid>/permanent/ai-images/…)
   * quand storage === "r2". Jamais expirée — à re-résoudre en URL signée
   * au besoin (createPermanentDownloadUrl / /api/storage/permanent).
   */
  storagePath?: string;
}

/** Sous-dossier sûr : lettres/chiffres/tiret/underscore uniquement. */
function sanitizePrefix(prefix?: string): string {
  const cleaned = (prefix ?? DEFAULT_PREFIX)
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : DEFAULT_PREFIX;
}

/** Extension déduite du type MIME (parité avec engine.ts). */
function extensionFor(contentType: string): string {
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("avif")) return "avif";
  return "png";
}

/**
 * Copie l'image générée dans le stockage PERMANENT de l'utilisateur (R2).
 * Ne lève JAMAIS : en cas d'échec, l'URL d'origine reste utilisable
 * (storage:"provider") — la génération ne doit pas être perdue pour un
 * incident d'archivage.
 */
export async function persistGeneratedImage(
  params: PersistGeneratedImageParams,
): Promise<PersistedImage> {
  const original = params.imageUrl;
  try {
    const userId =
      typeof params.userId === "string" ? params.userId.trim() : "";
    const source =
      typeof original === "string" ? original.trim() : "";

    // Sans propriétaire ni source exploitable, rien à persister — repli
    // immédiat (jamais d'exception).
    if (!userId || !source) {
      return { url: original, storage: "provider" };
    }

    // R2 non configuré : pas de destination permanente possible (le repli
    // inline data URI du chat n'a pas d'équivalent ici — gonflerait la
    // réponse JSON de l'outil sans garantir l'affichage).
    if (!isR2Configured()) {
      return { url: original, storage: "provider" };
    }

    let buffer: Buffer;
    let contentType: string;

    // Voie 1 — data URI Base64 : décodage direct, aucun téléchargement.
    const dataUriMatch =
      /^data:([^;,]+);base64,(.+)$/s.exec(source);
    if (dataUriMatch) {
      contentType =
        typeof dataUriMatch[1] === "string" &&
        dataUriMatch[1].trim().length > 0
          ? dataUriMatch[1].trim().toLowerCase()
          : "image/png";
      buffer = Buffer.from(dataUriMatch[2] ?? "", "base64");
    } else if (/^https?:\/\//i.test(source)) {
      // Voie 2 — URL https provider : téléchargement borné (timeout +
      // limite de taille), même pattern que le chat (engine.ts).
      const response = await fetch(source, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { url: original, storage: "provider" };
      }
      contentType = (
        response.headers.get("content-type") || "image/png"
      )
        .split(";")[0]
        .trim();
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      // Ni data URI ni http(s) : source non ré-hébergeable.
      return { url: original, storage: "provider" };
    }

    // Vide ou au-delà de la limite : on ne persiste pas un objet aberrant.
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      return { url: original, storage: "provider" };
    }

    const key = `users/${userId}/permanent/${sanitizePrefix(params.prefix)}/${Date.now()}-${randomUUID()}.${extensionFor(contentType)}`;
    await uploadToR2(key, buffer, contentType);

    // URL signée d'accès direct à la copie PERMANENTE (affichage/
    // téléchargement immédiat) ; le handle durable reste storagePath.
    const url = await createR2DownloadUrl(key, SIGNED_URL_TTL_S);
    return { url, storage: "r2", storagePath: key };
  } catch {
    // Dégradation gracieuse (parité avec le chat) : JAMAIS de throw — un
    // échec d'archivage ne doit pas annuler une génération réussie.
    return { url: original, storage: "provider" };
  }
}
