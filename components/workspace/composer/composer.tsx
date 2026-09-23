"use client";

import { useEffect, useRef, useState } from "react";

import { ConnectorPicker } from "./connector-picker";
import type { MessageAttachment } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * Composer de conversation : texte multi-lignes, pièces jointes (stockage
 * permanent réel), connecteurs activables pour le message, sélection du
 * projet de contexte et envoi au clavier.
 */

interface ComposerProps {
  onSend: (message: string, attachments: MessageAttachment[]) => Promise<void>;
  disabled?: boolean;
  projects: WorkspaceProject[];
  projectId?: string;
  onProjectChange?: (projectId: string | undefined) => void;
  /** Connecteurs activés pour le prochain message (slugs Composio). */
  connectors?: string[];
  onConnectorsChange?: (connectors: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  autoFocus?: boolean;
}

export function Composer({
  onSend,
  disabled = false,
  projects,
  projectId,
  onProjectChange,
  connectors = [],
  onConnectorsChange,
  suggestions,
  placeholder = "Décrivez votre objectif — Gen3ia planifie et exécute…",
  autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [value]);

  const uploadFile = async (file: File) => {
    setUploadError("");
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/storage/permanent", { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Envoi du fichier impossible.");
      }
      const data = (await response.json()) as { file: { path: string; filename: string; contentType?: string; sizeBytes?: number } };
      setAttachments((current) => [
        ...current.slice(0, 7),
        {
          filename: data.file.filename,
          path: data.file.path,
          contentType: data.file.contentType,
          sizeBytes: data.file.sizeBytes,
        },
      ]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Envoi du fichier impossible.");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    const message = value.trim();
    if (!message || disabled) return;
    setValue("");
    const sent = attachments;
    setAttachments([]);
    await onSend(message, sent);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="space-y-2">
      {suggestions && suggestions.length > 0 && value === "" && attachments.length === 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggestions de départ">
          {suggestions.slice(0, 4).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setValue(suggestion)}
              className="g3-chip text-[11px]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pièces jointes">
          {attachments.map((attachment, index) => (
            <li
              key={`${attachment.filename}-${index}`}
              className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] text-neutral-700"
            >
              <span aria-hidden>📎</span>
              <span className="truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                className="text-neutral-400 hover:text-red-500"
                aria-label={`Retirer ${attachment.filename}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {uploadError && <p className="text-[11px] text-red-600" role="alert">{uploadError}</p>}

      <div className="g3-card flex items-end gap-2 !p-2">
        <label className="g3-btn g3-btn-ghost !min-h-0 shrink-0 cursor-pointer !px-2 !py-1.5 text-sm" title="Joindre un fichier">
          📎
          <input
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
              event.target.value = "";
            }}
            disabled={uploading || disabled}
          />
        </label>

        {onConnectorsChange && (
          <ConnectorPicker selected={connectors} onChange={onConnectorsChange} disabled={disabled} />
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          autoFocus={autoFocus}
          disabled={disabled}
          className="max-h-[220px] min-h-[40px] flex-1 resize-none border-0 bg-transparent px-1 py-2 text-sm leading-relaxed outline-none placeholder:text-neutral-400"
          aria-label="Message pour l'agent"
        />

        {projects.length > 0 && (
          <select
            value={projectId ?? ""}
            onChange={(event) => onProjectChange?.(event.target.value || undefined)}
            className="g3-select !min-h-0 !w-auto max-w-[140px] shrink-0 !py-1.5 text-[11px]"
            aria-label="Projet de contexte"
            title="Projet de contexte (instructions, fichiers, connecteurs)"
          >
            <option value="">Sans projet</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                ▦ {project.name}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || !value.trim()}
          className="g3-btn g3-btn-primary shrink-0 !px-3 text-sm"
          title="Envoyer (Entrée)"
        >
          {disabled ? "…" : "Envoyer ↵"}
        </button>
      </div>
      {uploading && <p className="text-[11px] text-neutral-500">Envoi du fichier en cours…</p>}
      {connectors.length > 0 && (
        <p className="text-[11px] text-neutral-500">
          Connecteurs activés : <span className="font-semibold text-neutral-800">{connectors.join(", ")}</span> — les
          actions externes restent soumises à votre validation.
        </p>
      )}
    </div>
  );
}
