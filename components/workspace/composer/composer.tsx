"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CommandComposer, type CommandComposerHandle } from "@/components/ui/command-composer";
import { authFetch } from "@/lib/firebase/auth-client";
import {
  AUTHORIZATION_MODE_STORAGE_KEY,
  DEFAULT_AUTHORIZATION_MODE,
  isAuthorizationMode,
  type AuthorizationMode,
} from "@/lib/security/authorization-mode";
import type { ComposerCommand, MentionItem } from "@/lib/ui/command-composer-helpers";
import type { MessageAttachment } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * Composer de conversation — réplique EXACTE de la maquette unifiée
 * (CommandComposer commun à tous les chats Gen3ia) :
 *  - grande zone de texte anthracite fortement arrondie, placeholder
 *    « Posez n'importe quelle question… Tapez @ pour mentionner des
 *    compétences ou connecteurs, ou / pour les commandes » ;
 *  - bouton « + » = pièce jointe RÉELLE (stockage permanent Gen3ia) ;
 *  - « @ » = applications connectées activables pour ce message ;
 *  - « / » = commandes (fichier, connecteurs, projet de contexte) ;
 *  - « Toujours demander ▼ » = mode d'autorisation HITL transmis au moteur
 *    (préférence partagée avec tous les chats, clé localStorage commune) ;
 *  - 🎙 saisie vocale fr-FR, bouton circulaire ↑ d'envoi.
 *
 * Les capacités propres à la conversation (pièces jointes multi-fichiers,
 * projet de contexte) sont proposées SANS dénaturer la maquette.
 */

export interface ComposerSendOptions {
  /** Mode d'autorisation lu dans la préférence partagée au moment de l'envoi. */
  authorizationMode?: AuthorizationMode;
}

interface ComposerProps {
  onSend: (message: string, attachments: MessageAttachment[], options?: ComposerSendOptions) => Promise<void>;
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

/** Lit la préférence de mode d'autorisation (partagée avec tous les chats). */
export function readAuthorizationMode(): AuthorizationMode {
  try {
    const stored = window.localStorage.getItem(AUTHORIZATION_MODE_STORAGE_KEY);
    return isAuthorizationMode(stored) ? stored : DEFAULT_AUTHORIZATION_MODE;
  } catch {
    return DEFAULT_AUTHORIZATION_MODE;
  }
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
  placeholder,
  autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  // Libellés lisibles des connecteurs déjà vus dans le sélecteur « @ » (état,
  // pas une ref : ils servent au rendu des puces activées).
  const [mentionLabels, setMentionLabels] = useState<Map<string, MentionItem>>(() => new Map());
  const composerRef = useRef<CommandComposerHandle | null>(null);

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus();
  }, [autoFocus]);

  const uploadFile = async (file: File) => {
    setUploadError("");
    setUploading(true);
    setUploadingName(file.name);
    try {
      // Import RÉEL : le fichier est réellement converti (CSV → lignes, JSON →
      // structure, XLSX, DOCX, HTML, PDF natif, texte) puis stocké dans la base
      // de données du projet (Firestore). Le contenu converti accompagne ensuite
      // le message — le modèle travaille sur le contenu réel, pas sur un nom.
      const form = new FormData();
      form.append("file", file);
      if (projectId) form.append("projectId", projectId);
      const response = await fetch("/api/files/import", { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Envoi du fichier impossible.");
      }
      const data = (await response.json()) as {
        file: { id: string; filename: string; kind: string; charCount: number; rowCount?: number; contentType: string; sizeBytes: number; conversion: string };
      };
      setAttachments((current) => [
        ...current.slice(0, 7),
        {
          filename: data.file.filename,
          fileId: data.file.id,
          fileKind: data.file.kind,
          charCount: data.file.charCount,
          ...(data.file.rowCount !== undefined ? { rowCount: data.file.rowCount } : {}),
          contentType: data.file.contentType,
          sizeBytes: data.file.sizeBytes,
        },
      ]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Envoi du fichier impossible.");
    } finally {
      setUploading(false);
      setUploadingName(null);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = value.trim();
    if (!message || disabled) return;
    setValue("");
    const sent = attachments;
    setAttachments([]);
    await onSend(message, sent, { authorizationMode: readAuthorizationMode() });
  };

  /* « @ » — applications connectées (même API de mentions que les autres chats). */
  const loadMentions = useCallback(async (query: string): Promise<MentionItem[]> => {
    try {
      const response = await authFetch(`/api/integrations/mention?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (!response.ok) return [];
      const data = (await response.json()) as { connectors?: MentionItem[] };
      const items = Array.isArray(data.connectors) ? data.connectors : [];
      if (items.length > 0) {
        setMentionLabels((current) => {
          const next = new Map(current);
          for (const item of items) next.set(item.toolkit, item);
          return next;
        });
      }
      return items;
    } catch {
      return [];
    }
  }, []);

  const activatedMentions: MentionItem[] = connectors.map(
    (toolkit) =>
      mentionLabels.get(toolkit) ?? {
        toolkit,
        label: toolkit,
        description: "Application connectée",
        category: "connecteur",
        connected: true,
      },
  );

  const activateMention = (item: MentionItem) => {
    if (connectors.some((toolkit) => toolkit === item.toolkit)) return;
    onConnectorsChange?.([...connectors, item.toolkit].slice(0, 8));
  };

  const deactivateMention = (toolkit: string) => {
    onConnectorsChange?.(connectors.filter((item) => item !== toolkit));
  };

  /* « / » — commandes rapides : fichier, connecteurs, projet de contexte
     (littéral unique + épandages, comme dans les autres chats Gen3ia). */
  const projectCommands: ComposerCommand[] = projects
    .slice(0, 8)
    .filter((project) => project.id !== projectId)
    .map((project) => ({
      id: `projet-${project.id}`,
      label: `Projet : ${project.name}`,
      description: "Envoie avec ce contexte projet (instructions, fichiers, connecteurs).",
      run: () => onProjectChange?.(project.id),
    }));
  const commands: ComposerCommand[] = [
    {
      id: "fichier",
      label: "Joindre un fichier",
      description: "CSV, JSON, XLSX, DOCX, PDF, TXT… — réellement converti et stocké en base de données.",
      run: () => composerRef.current?.openFilePicker(),
    },
    ...(onConnectorsChange
      ? [
          {
            id: "connecteurs",
            label: "Choisir des connecteurs",
            description: "Mentionnez une application connectée à utiliser pour ce message.",
            run: () => composerRef.current?.openMentions(),
          },
        ]
      : []),
    ...(projectId
      ? [
          {
            id: "sans-projet",
            label: "Sans projet",
            description: "Détache le contexte projet du prochain message.",
            run: () => onProjectChange?.(undefined),
          },
        ]
      : []),
    ...projectCommands,
  ];

  const activeProject = projects.find((project) => project.id === projectId) ?? null;

  return (
    <div className="space-y-2">
      {suggestions && suggestions.length > 0 && value === "" && attachments.length === 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggestions de départ">
          {suggestions.slice(0, 4).map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => setValue(suggestion)} className="g3-chip text-[11px]">
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {uploadError && <p className="text-[11px] text-red-600" role="alert">{uploadError}</p>}

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pièces jointes">
          {attachments.map((attachment, index) => (
            <li key={`${attachment.filename}-${index}`} className="g3-chip !py-1 text-[11px]">
              <span aria-hidden>📎</span>
              <span className="max-w-[220px] truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                className="text-[var(--g3-faint)] hover:text-red-500"
                aria-label={`Retirer ${attachment.filename}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeProject && (
        <p className="text-[11px] text-[var(--g3-muted)]">
          Contexte projet : <span className="font-semibold text-[var(--g3-text)]">{activeProject.name}</span> — tapez / pour changer de projet.
        </p>
      )}

      <CommandComposer
        ref={composerRef}
        value={value}
        onValueChange={setValue}
        onSubmit={submit}
        disabled={disabled}
        maxLength={20_000}
        placeholder={placeholder}
        plusAction="file"
        onFile={(file) => void uploadFile(file)}
        attachmentName={uploadingName}
        attachmentUploading={uploading}
        loadMentions={onConnectorsChange ? loadMentions : undefined}
        activatedMentions={activatedMentions}
        onActivateMention={activateMention}
        onDeactivateMention={deactivateMention}
        commands={commands}
      />
    </div>
  );
}
