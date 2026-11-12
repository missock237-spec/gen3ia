/**
 * Politique UNIFIÉE des pièces jointes Gen3ia (exigence production).
 *
 * Une seule source de vérité, partagée par TOUTES les surfaces qui
 * manipulent des pièces jointes (composer de conversation, chat d'agent
 * plein écran, import de fichiers, ingestion Knowledge, routes API) :
 *
 *  - 15 pièces jointes MAXIMUM par message ;
 *  - 100 Mo MAXIMUM par pièce jointe.
 *
 * Module pur (aucune dépendance serveur, aucun « server-only ») : importable
 * côté client (validation immédiate avant envoi) comme côté serveur
 * (validation zod / policy — le serveur reste l'autorité finale).
 */

/** Nombre maximal de pièces jointes par message (demande : 15 × 100 Mo simultanés). */
export const ATTACHMENT_MAX_FILES = 15;

/** Taille maximale d'une pièce jointe : 100 Mo (alignée sur MAX_FILE_BYTES). */
export const ATTACHMENT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Taille totale maximale d'un lot de pièces jointes (15 × 100 Mo). */
export const ATTACHMENT_MAX_TOTAL_BYTES = ATTACHMENT_MAX_FILES * ATTACHMENT_MAX_FILE_BYTES;

/** Libellé canonique affichable (UI) — un seul texte partout. */
export function attachmentLimitLabel(): string {
  return `${ATTACHMENT_MAX_FILES} fichiers maximum par message, ${Math.round(ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024))} Mo par fichier.`;
}

/** Validation client d'une pièce jointe avant téléversement. */
export function validateAttachment(file: {
  name: string;
  size: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!file.name.trim()) return { ok: false, reason: "Nom de fichier invalide." };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, reason: "Fichier vide." };
  if (file.size > ATTACHMENT_MAX_FILE_BYTES) {
    return { ok: false, reason: `Fichier trop volumineux (max ${Math.round(ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024))} Mo).` };
  }
  return { ok: true };
}
