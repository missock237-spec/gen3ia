import "server-only";

import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES } from "@/lib/files/attachment-policy";
import { convertFileBuffer, isOwnedPermanentKey } from "@/lib/files/import";
import { downloadFromR2 } from "@/lib/storage/r2";

/**
 * Contexte RÉEL des pièces jointes du chat d'agent (exigence production :
 * « une fois associées, les pièces jointes doivent pouvoir être utilisées
 * par l'agent IA ou dans une conversation selon la demande de
 * l'utilisateur »).
 *
 * Avant ce module, le chat d'agent ne transmettait que les NOMS des fichiers
 * (la note suggérait `file.read`, qui lit un workspace éphémère — pas le
 * stockage permanent) : l'agent ne pouvait JAMAIS lire le contenu.
 *
 * Désormais : chaque pièce jointe (clé R2 permanente du propriétaire) est
 * téléchargée, convertie (texte, CSV, JSON, XLSX, DOCX, HTML, PDF natif)
 * et son contenu réel est injecté dans le prompt (chat ET planification).
 * Les budgets sont alignés sur la politique 10 fichiers × 50 Mo ; les
 * images sont annoncées comme disponibles (métadonnées + chemin R2) sans
 * extraction illusoire.
 */

/** Caractères injectés par fichier (aligné sur loadImportedFilesContext). */
const PER_FILE_CHARS = 12_000;
/** Budget total du bloc de contexte pièces jointes (10 fichiers). */
const TOTAL_CHARS = 60_000;

export interface AgentChatAttachment {
  path: string;
  name: string;
  sizeBytes?: number;
  contentType?: string;
}

export interface LoadedAttachmentContext {
  /** Bloc de contexte à injecter dans le prompt ("" si aucune pièce jointe). */
  note: string;
  /** Résultats par fichier — pour la persistance et la journalisation. */
  files: Array<{
    name: string;
    path: string;
    kind?: string;
    conversion?: "full" | "metadata-only";
    charCount?: number;
    rowCount?: number;
    pageCount?: number;
    error?: string;
  }>;
}

/** Construit la note de contexte réelle des pièces jointes (fail-soft). */
export async function loadAgentAttachmentsContext(
  userId: string,
  attachments: AgentChatAttachment[],
): Promise<LoadedAttachmentContext> {
  if (!attachments || attachments.length === 0) return { note: "", files: [] };

  const files: LoadedAttachmentContext["files"] = [];
  const parts: string[] = [];
  const bullets: string[] = [];
  let total = 0;

  for (const attachment of attachments.slice(0, ATTACHMENT_MAX_FILES)) {
    const label = attachment.name.slice(0, 200);
    // Cloisonnement : seule la clé permanente de CE propriétaire est lisible.
    if (!isOwnedPermanentKey(userId, attachment.path)) {
      files.push({ name: label, path: attachment.path, error: "chemin hors stockage permanent du compte" });
      bullets.push(`- « ${label} » (${attachment.path}) : non lue automatiquement — consulte-la à la demande avec l'outil file.read (input { path: "${attachment.path}" }).`);
      continue;
    }
    try {
      const buffer = await downloadFromR2(attachment.path, ATTACHMENT_MAX_FILE_BYTES);
      if (!buffer || buffer.length === 0) {
        files.push({ name: label, path: attachment.path, error: "fichier introuvable dans le stockage" });
        bullets.push(`- « ${label} » (${attachment.path}) : non lue (introuvable dans le stockage) — tente file.read (input { path: "${attachment.path}" }) si nécessaire.`);
        continue;
      }
      const conversion = await convertFileBuffer(buffer, attachment.name, attachment.contentType || "application/octet-stream", buffer.length);
      files.push({
        name: label,
        path: attachment.path,
        kind: conversion.kind,
        conversion: conversion.conversion,
        charCount: conversion.text.length,
        ...(conversion.rowCount !== undefined ? { rowCount: conversion.rowCount } : {}),
        ...(conversion.pageCount !== undefined ? { pageCount: conversion.pageCount } : {}),
      });
      const statsLabel = conversion.conversion === "full"
        ? `${conversion.text.length.toLocaleString("fr-FR")} caractères extraits`
        : "contenu non textuel (image/binaire) — métadonnées disponibles";
      bullets.push(`- « ${label} » (${attachment.path}) : ${statsLabel}.`);
      const header = `Pièce jointe « ${label} » (${conversion.kind}) :`;
      const budget = Math.max(0, Math.min(PER_FILE_CHARS, TOTAL_CHARS - total));
      if (budget > 0) {
        const body = conversion.text
          ? conversion.text.slice(0, budget)
          : conversion.note || `(aucun contenu texte extractible — binaire disponible : ${attachment.path})`;
        parts.push(`${header}\n${body}`);
        total += header.length + body.length;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 160) : "lecture impossible";
      files.push({ name: label, path: attachment.path, error: reason });
      bullets.push(`- « ${label} » (${attachment.path}) : non lue (${reason}) — tente file.read (input { path: "${attachment.path}" }) si nécessaire.`);
    }
  }

  if (bullets.length === 0) return { note: "", files };

  const readCount = files.filter((file) => !file.error).length;
  const note = [
    `[Contexte fourni par l'utilisateur : ${attachments.length} fichiers joints.`,
    ...bullets,
    ...(parts.length > 0
      ? ["", `CONTENU RÉEL des fichiers lus (${readCount}/${attachments.length}) — appuie-toi sur ce contenu, ne l'invente jamais :`, parts.join("\n\n---\n\n")]
      : []),
    "]",
  ].join("\n");
  return { note, files };
}
