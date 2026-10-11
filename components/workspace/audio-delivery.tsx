"use client";

import { useCallback, useEffect, useState } from "react";

import { downloadUrl } from "@/lib/client/download";
import type { ConversationArtifact } from "@/lib/domain/conversations/types";

/**
 * LIVRAISON DIRECTE DE L'AUDIO (Task 123) : le fil ne porte PLUS de lien
 * markdown d'écoute (une URL signée expire — après 1 h, la livraison était un
 * lien mort). Chaque audio synthétisé est archivé en PERMANENT dans R2
 * (storagePath de l'artefact) et ce composant le rend DIRECTEMENT :
 *  - un VRAI lecteur HTML5 <audio controls preload="metadata"> dont la source
 *    est une URL signée RÉSOLUE À LA DEMANDE depuis la clé permanente
 *    (canal /api/storage/permanent — la même que le panneau des livrables) ;
 *  - un bouton « Télécharger » (téléchargement direct, attribut download).
 *
 * Auto-refresh : le composant apparaît dès que l'artefact/la réponse arrive
 * dans l'état réactif du fil — aucun rechargement de page.
 * Style : tokens du design system (var(--g3-*)) uniquement, aucune couleur neuve.
 */

interface AudioDeliveryProps {
  /** Libellé lisible (titre de l'artefact / extrait du texte synthétisé). */
  title: string;
  /** Clé R2 permanente (résolue en URL signée courte à la demande). */
  storagePath?: string;
  /** URL directe de repli (legacy : ancien lien signé) — utilisée en dernier. */
  url?: string;
  /** Data URI (repli inline sans archivage) — lisible directement. */
  dataUri?: string;
  /** Nom de fichier proposé au téléchargement. */
  filename?: string;
  className?: string;
}

/** Résout une clé de stockage permanent en URL signée (canal signé interne). */
async function resolvePermanentUrl(path: string): Promise<string> {
  const response = await fetch(`/api/storage/permanent?path=${encodeURIComponent(path)}`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Lien indisponible.");
  const data = (await response.json()) as { url: string };
  return data.url;
}

/** Nom de fichier par défaut (slug du titre + extension audio). */
function defaultAudioFilename(title: string): string {
  const base = (title || "audio").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "audio";
  return `gen3ia-${base}.mp3`;
}

export function AudioDelivery({ title, storagePath, url, dataUri, filename, className = "" }: AudioDeliveryProps) {
  // Ordre de résolution : data URI (inline) > clé permanente (signée fraîche) >
  // URL legacy. La clé permanente PRIME sur l'ancien lien signé (expirable).
  const needsResolution = Boolean(!dataUri && storagePath);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!needsResolution) return;
    let cancelled = false;
    setResolvedUrl(null);
    setResolveError(false);
    resolvePermanentUrl(storagePath as string)
      .then((signed) => {
        if (!cancelled) setResolvedUrl(signed);
      })
      .catch(() => {
        if (!cancelled) setResolveError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsResolution, storagePath, attempt]);

  const src = dataUri ?? resolvedUrl ?? (url && /^https?:\/\//.test(url) ? url : undefined);
  const downloadName = filename ?? defaultAudioFilename(title);

  const download = useCallback(() => {
    if (!src) return;
    if (dataUri) {
      const anchor = document.createElement("a");
      anchor.href = dataUri;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    void downloadUrl(src, downloadName);
  }, [dataUri, downloadName, src]);

  if (!storagePath && !dataUri && !url) return null;

  return (
    <div className={`mt-2.5 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-2.5 ${className}`}>
      <p className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[var(--g3-text-secondary)]">
        <span aria-hidden>🔉</span>
        <span className="truncate" title={title}>{title}</span>
      </p>
      {src ? (
        <>
          {/* VRAI lecteur HTML5 — livraison directe, source résolue à la demande. */}
          <audio controls preload="metadata" src={src} aria-label={`Lecteur audio : ${title}`} className="h-9 w-full" />
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              onClick={download}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
              aria-label={`Télécharger l'audio : ${title}`}
            >
              <span aria-hidden>⬇</span> Télécharger
            </button>
          </div>
        </>
      ) : resolveError ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-[var(--g3-muted)]">Audio archivé — lien momentanément indisponible.</p>
          <button
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
            aria-label={`Réessayer de charger l&apos;audio : ${title}`}
          >
            <span aria-hidden>↻</span> Réessayer
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-[var(--g3-muted)]" aria-live="polite">Chargement de l&apos;audio…</p>
      )}
    </div>
  );
}

/**
 * Associe les artefacts AUDIO aux messages du fil (pur, réutilisable) :
 *  - artefact lié à un run → message porteur de ce runId (livrable d'étape) ;
 *  - artefact de tour vocal (sans run) → DERNIER message assistant précédant
 *    sa création (l'horodatage ISO est comparable lexicographiquement) ;
 *  - sans message assistant antérieur → premier message assistant du fil.
 * Le lecteur s'affiche ainsi MÊME SANS texte explicite dans le message.
 */
export function attachAudioArtifactsToMessages<M extends { id: string; role: string; runId?: string; createdAt: string }>(
  messages: M[],
  audioArtifacts: ConversationArtifact[],
): Map<string, ConversationArtifact[]> {
  const byMessage = new Map<string, ConversationArtifact[]>();
  if (audioArtifacts.length === 0 || messages.length === 0) return byMessage;

  const add = (messageId: string, artifact: ConversationArtifact) => {
    const list = byMessage.get(messageId);
    if (list) {
      if (!list.some((existing) => existing.id === artifact.id)) list.push(artifact);
    } else {
      byMessage.set(messageId, [artifact]);
    }
  };

  const messageByRunId = new Map<string, M>();
  for (const message of messages) {
    if (message.runId) messageByRunId.set(message.runId, message);
  }
  const firstAssistant = messages.find((message) => message.role !== "user") ?? messages[0];

  for (const artifact of audioArtifacts) {
    if (artifact.runId && messageByRunId.has(artifact.runId)) {
      add(messageByRunId.get(artifact.runId)!.id, artifact);
      continue;
    }
    // Dernier message assistant créé AVANT l'artefact (chronologie du fil).
    let target: M | undefined;
    for (const message of messages) {
      if (message.role === "user") continue;
      if (artifact.createdAt >= message.createdAt) target = message;
      else break;
    }
    add((target ?? firstAssistant).id, artifact);
  }
  return byMessage;
}
