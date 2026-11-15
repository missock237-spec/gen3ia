/**
 * FILTRE DE CONTENU — PIÈCES JOINTES IMAGE (Task 42, axe 4).
 *
 * Valide les pièces jointes vision AVANT tout appel provider : nombre,
 * taille binaire réelle (décodage base64), formats supportés par les
 * modèles servis, cohérence du préfixe data: et URLs http(s) uniquement
 * (anti-SSRF basique : pas de file:, data:, javascript:…).
 *
 * Politique de confidentialité : les images transitent en mémoire vers le
 * provider choisi (same-trust que le texte de la conversation) ; aucune
 * persistance par ce module ; les octets ne sont jamais loggés.
 */

import type { AIImageAttachment } from "./models";

export const MAX_IMAGES_PER_REQUEST = 4;
/** 5 Mo par image (après décodage base64 — taille binaire réelle). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const BASE64_IMAGE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ContentFilterResult {
  ok: boolean;
  errors: string[];
  /** Nombre d'images acceptées (0 si !ok). */
  accepted: number;
}

function base64ByteLength(data: string): number {
  // Longueur binaire réelle d'un payload base64 sans padding ambigu.
  const stripped = data.replace(/\s/g, "");
  const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((stripped.length * 3) / 4) - padding);
}

export function validateImageAttachments(images: AIImageAttachment[] | undefined): ContentFilterResult {
  const errors: string[] = [];
  if (!images || images.length === 0) return { ok: true, errors, accepted: 0 };

  if (images.length > MAX_IMAGES_PER_REQUEST) {
    errors.push(`Trop d'images : ${images.length} (maximum ${MAX_IMAGES_PER_REQUEST}).`);
  }

  let accepted = 0;
  for (const [index, image] of images.entries()) {
    const label = `image ${index + 1}`;
    if (!ALLOWED_MEDIA_TYPES.includes(image.mediaType)) {
      errors.push(`${label} : format ${image.mediaType} non supporté (formats acceptés : ${ALLOWED_MEDIA_TYPES.join(", ")}).`);
      continue;
    }

    if (image.source.type === "base64") {
      const data = image.source.data.replace(/\s/g, "").replace(/^data:[^;]+;base64,/, "");
      if (data.length === 0) {
        errors.push(`${label} : contenu base64 vide.`);
        continue;
      }
      if (!BASE64_IMAGE_RE.test(data)) {
        errors.push(`${label} : contenu base64 invalide.`);
        continue;
      }
      const bytes = base64ByteLength(data);
      if (bytes > MAX_IMAGE_BYTES) {
        errors.push(`${label} : ${(bytes / (1024 * 1024)).toFixed(1)} Mo (maximum ${MAX_IMAGE_BYTES / (1024 * 1024)} Mo).`);
        continue;
      }
      accepted += 1;
      continue;
    }

    // source.type === "url" : http(s) uniquement (anti-SSRF basique).
    const url = image.source.url.trim();
    if (!/^https:\/\//i.test(url)) {
      errors.push(`${label} : URL non autorisée (https requis).`);
      continue;
    }
    if (url.length > 2_048) {
      errors.push(`${label} : URL trop longue.`);
      continue;
    }
    accepted += 1;
  }

  const expected = Math.min(images.length, MAX_IMAGES_PER_REQUEST);
  return { ok: errors.length === 0 && accepted === expected, errors, accepted: errors.length === 0 ? accepted : 0 };
}
