/**
 * ENTRÉE VISION — attachments de conversation → `AIMessage.images`.
 *
 * Les providers (openai-compatible, anthropic) consomment déjà le champ
 * `AIMessage.images` (parts vision réelles : `image_url` côté OpenAI,
 * blocs `image` côté Anthropic) ; ce module fait le PONT entre les pièces
 * jointes du domaine conversationnel (`MessageAttachment`) et ce contrat
 * provider. Fonction PURE et synchrone : testable sans réseau ni stockage.
 *
 * Conversion :
 *  - URL **https** → source `{ type: "url" }` (image_url OpenAI / source url
 *    Anthropic) ;
 *  - data URI `data:image/…;base64,…` → source `{ type: "base64" }`
 *    (décodée du préfixe data: — contrat accepté nativement par les deux
 *    providers, sans ressource réseau) ;
 *
 * Garde-fous (alignés sur lib/ai/content-filter.ts) :
 *  - seuls les formats servis par les modèles vision sont retenus
 *    (png/jpeg/webp/gif — ALLOWED_MEDIA_TYPES) ; un format non supporté est
 *    ÉCARTÉ (validateImageAttachments le rejetterait et ferait échouer la
 *    requête entière) ;
 *  - `http://` et tout autre schéma sont écartés (le filtre anti-SSRF
 *    n'accepte que https) ;
 *  - un attachment réduit à une clé R2 (`path`, sans `url`) est ignoré ici :
 *    sa résolution exige une URL signée côté serveur (accès disque/R2), hors
 *    du contrat d'une fonction pure — la couche appelante peut le résoudre
 *    avant l'appel si besoin ;
 *  - plafond MAX_IMAGES_PER_REQUEST (même contrat que le filtre de contenu).
 */

import type { AIImageAttachment } from "./models";
import { ALLOWED_MEDIA_TYPES, MAX_IMAGES_PER_REQUEST } from "./content-filter";
import type { MessageAttachment } from "@/lib/domain/conversations/types";

const SUPPORTED_MEDIA_TYPES = new Set<string>(ALLOWED_MEDIA_TYPES);

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** https uniquement : validateImageAttachments rejette tout autre schéma. */
const HTTPS_URL_RE = /^https:\/\//i;

/**
 * Normalise un content-type quelconque vers un mediaType SERVI par les
 * modèles vision (les sous-types exotiques — svg, heic, avif… — sont rejetés
 * plutôt que propagés : ils feraient échouer la requête au filtre).
 */
function normalizeMediaType(value: string | undefined): AIImageAttachment["mediaType"] | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  if (!mime || !mime.startsWith("image/")) return null;
  // Alias historique fréquent : image/jpg n'existe pas en tant que type officiel.
  if (mime === "image/jpg") return "image/jpeg";
  return SUPPORTED_MEDIA_TYPES.has(mime) ? (mime as AIImageAttachment["mediaType"]) : null;
}

/** Déduit le mediaType depuis l'extension du nom de fichier (repli). */
function mediaTypeFromFilename(filename: string | undefined): AIImageAttachment["mediaType"] | null {
  const ext = filename?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}

/**
 * Convertit les attachments d'un message en entrées `AIMessage.images`
 * réellement consommables par les providers vision.
 *
 * Retourne `undefined` quand rien n'est exploitable (aucun champ `images`
 * émis : les providers ignorent la vision et le filtre de contenu n'a
 * rien à rejeter — comportement exactement rétrocompatible).
 */
export function imagesForModel(attachments?: MessageAttachment[] | null): AIImageAttachment[] | undefined {
  const images: AIImageAttachment[] = [];
  for (const attachment of attachments ?? []) {
    if (images.length >= MAX_IMAGES_PER_REQUEST) break;
    const url = attachment.url?.trim();
    if (!url) continue;

    // 1) Data URI : décodée en source base64 (aucun réseau, contrat natif).
    const dataUri = DATA_URI_RE.exec(url);
    if (dataUri) {
      const mediaType = normalizeMediaType(dataUri[1]);
      if (!mediaType) continue;
      images.push({
        mediaType,
        source: { type: "base64", data: dataUri[2]!.replace(/\s/g, "") },
      });
      continue;
    }

    // 2) URL https (anti-SSRF : tout autre schéma est écarté).
    if (!HTTPS_URL_RE.test(url)) continue;
    // Garde « image uniquement » : un content-type image OU une extension
    // image est requis — jamais un fichier quelconque transformé en vision.
    const mediaType = normalizeMediaType(attachment.contentType) ?? mediaTypeFromFilename(attachment.filename);
    if (!mediaType) continue;
    images.push({
      mediaType,
      source: { type: "url", url },
    });
  }
  return images.length > 0 ? images : undefined;
}
