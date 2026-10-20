import "server-only";

import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES } from "@/lib/files/attachment-policy";
import { convertFileBuffer, isOwnedPermanentKey } from "@/lib/files/import";
import { downloadFromR2 } from "@/lib/storage/r2";
import { mapWithConcurrency } from "@/lib/video/concurrency";

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
 *
 * OPTIMISATION (audit multimodal) : la boucle séquentielle (jusqu'à 10 ×
 * téléchargement + conversion = plusieurs secondes) est parallélisée avec
 * une concurrence bornée (4) — l'ORDRE des résultats est préservé.
 */

/** Caractères injectés par fichier (aligné sur loadImportedFilesContext). */
const PER_FILE_CHARS = 12_000;
/** Budget total du bloc de contexte pièces jointes (10 fichiers). */
const TOTAL_CHARS = 60_000;
/** Concurrence de lecture (téléchargement + conversion) par lot. */
const LECTURE_PARALLELE = 4;

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

/** Résultat unitaire d'une pièce jointe (ordre préservé à l'assemblage). */
interface ResultatPieceJointe {
  label: string;
  path: string;
  /** Puce de statut (toujours produite — succès comme échec). */
  bullet: string;
  /** Bloc de contenu (aucune pièce jointe lisible → absent). */
  part?: { header: string; body: string };
  /** Texte converti complet (troncé à l'assemblage selon budget global). */
  texte?: string;
  /** Entrée files() (toujours produite — succès comme échec). */
  file: LoadedAttachmentContext["files"][number];
}

async function lirePieceJointe(
  userId: string,
  attachment: AgentChatAttachment,
): Promise<ResultatPieceJointe> {
  const label = attachment.name.slice(0, 200);
  // Cloisonnement : seule la clé permanente de CE propriétaire est lisible.
  if (!isOwnedPermanentKey(userId, attachment.path)) {
    return {
      label,
      path: attachment.path,
      file: { name: label, path: attachment.path, error: "chemin hors stockage permanent du compte" },
      bullet: `- « ${label} » (${attachment.path}) : non lue automatiquement — consulte-la à la demande avec l'outil file.read (input { path: "${attachment.path}" }).`,
    };
  }
  try {
    const buffer = await downloadFromR2(attachment.path, ATTACHMENT_MAX_FILE_BYTES);
    if (!buffer || buffer.length === 0) {
      return {
        label,
        path: attachment.path,
        file: { name: label, path: attachment.path, error: "fichier introuvable dans le stockage" },
        bullet: `- « ${label} » (${attachment.path}) : non lue (introuvable dans le stockage) — tente file.read (input { path: "${attachment.path}" }) si nécessaire.`,
      };
    }
    const conversion = await convertFileBuffer(buffer, attachment.name, attachment.contentType || "application/octet-stream", buffer.length);
    const file: LoadedAttachmentContext["files"][number] = {
      name: label,
      path: attachment.path,
      kind: conversion.kind,
      conversion: conversion.conversion,
      charCount: conversion.text.length,
      ...(conversion.rowCount !== undefined ? { rowCount: conversion.rowCount } : {}),
      ...(conversion.pageCount !== undefined ? { pageCount: conversion.pageCount } : {}),
    };
    const statsLabel = conversion.conversion === "full"
      ? `${conversion.text.length.toLocaleString("fr-FR")} caractères extraits`
      : "contenu non textuel (image/audio/vidéo/binaire) — métadonnées disponibles";
    const header = `Pièce jointe « ${label} » (${conversion.kind}) :`;
    const body = conversion.text
      ? "" // Rempli à l'assemblage (budget global séquentiel) — voir plus bas.
      : conversion.note || `(aucun contenu texte extractible — binaire disponible : ${attachment.path})`;
    return {
      label,
      path: attachment.path,
      file,
      bullet: `- « ${label} » (${attachment.path}) : ${statsLabel}.`,
      part: { header, body },
      ...(conversion.text ? { texte: conversion.text } : {}),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 160) : "lecture impossible";
    return {
      label,
      path: attachment.path,
      file: { name: label, path: attachment.path, error: reason },
      bullet: `- « ${label} » (${attachment.path}) : non lue (${reason}) — tente file.read (input { path: "${attachment.path}" }) si nécessaire.`,
    };
  }
}

/** Construit la note de contexte réelle des pièces jointes (fail-soft). */
export async function loadAgentAttachmentsContext(
  userId: string,
  attachments: AgentChatAttachment[],
): Promise<LoadedAttachmentContext> {
  if (!attachments || attachments.length === 0) return { note: "", files: [] };

  // Lecture PARALLÈLISÉE à concurrence bornée, ordre d'entrée préservé
  // (mapWithConcurrency renvoie un résultat par item, dans l'ordre).
  const resultat = await mapWithConcurrency(
    attachments.slice(0, ATTACHMENT_MAX_FILES),
    LECTURE_PARALLELE,
    (attachment) => lirePieceJointe(userId, attachment),
  );

  const files: LoadedAttachmentContext["files"] = [];
  const parts: string[] = [];
  const bullets: string[] = [];
  let total = 0;

  for (const outcome of resultat) {
    if (outcome.status !== "fulfilled") {
      // Défense en profondeur : lirePieceJointe ne lève jamais, mais un
      // rejet imprévu reste signalé honnêtement au lieu de tout perdre.
      const raison = outcome.status === "rejected" && outcome.reason instanceof Error
        ? outcome.reason.message.slice(0, 160)
        : "lecture impossible";
      files.push({ name: "?", path: "?", error: raison });
      bullets.push(`- pièce jointe non lue (${raison}).`);
      continue;
    }
    const r = outcome.value;
    files.push(r.file);
    bullets.push(r.bullet);
    const budget = Math.max(0, Math.min(PER_FILE_CHARS, TOTAL_CHARS - total));
    if (budget > 0 && r.part) {
      const body = r.texte ? r.texte.slice(0, budget) : r.part.body;
      parts.push(`${r.part.header}\n${body}`);
      total += r.part.header.length + body.length;
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
