"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CommandComposer, type CommandComposerHandle } from "@/components/ui/command-composer";
import { authFetch } from "@/lib/firebase/auth-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import { ATTACHMENT_MAX_FILES, ATTACHMENT_MAX_FILE_BYTES, attachmentLimitLabel, validateAttachment } from "@/lib/files/attachment-policy";
import {
  AUTHORIZATION_MODE_STORAGE_KEY,
  DEFAULT_AUTHORIZATION_MODE,
  isAuthorizationMode,
  type AuthorizationMode,
} from "@/lib/security/authorization-mode";
import type { ComposerCommand, MentionItem } from "@/lib/ui/command-composer-helpers";
import { findModelOption } from "@/lib/ui/composer-models";
import type { MessageAttachment } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";
import { AgentPicker, type ComposerAgentOption } from "./agent-picker";
import { TemplateMenu } from "./template-menu";

/**
 * Composer de conversation — réplique EXACTE de la maquette unifiée
 * (CommandComposer commun à tous les chats Gen3ia) :
 *  - grande zone de texte anthracite fortement arrondie, placeholder
 *    « Posez n'importe quelle question… Tapez @ pour mentionner des
 *    compétences ou connecteurs, ou / pour les commandes » ;
 *  - bouton « + » = pièce jointe RÉELLE (stockage permanent Gen3ia) ;
 *  - « @ » = applications connectées activables pour ce message ;
 *  - « / » = commandes (fichier, connecteurs, projet, agent, modèles,
 *    moteur) ;
 *  - « Toujours demander ▼ » = mode d'autorisation HITL transmis au moteur
 *    (préférence partagée avec tous les chats, clé localStorage commune) ;
 *  - 🎙 saisie vocale fr-FR, bouton circulaire ↑ d'envoi.
 *
 * Task 141 — utilisation SIMPLE et FLEXIBLE :
 *  - sélecteur d'agent (pill + /agent) : QUI répond au prochain message ;
 *  - moteur IA unique : le système neuronal Gen3 (aucun sélecteur) ;
 *  - bibliothèque de modèles de prompts (pill + /modèle) : formulations
 *    réutilisables, enregistrables depuis le brouillon en cours ;
 *  - glisser-déposer de fichiers sur toute la zone du composer ;
 *  - pré-remplissage externe (chips de suivi, bouton « Réutiliser »).
 */

export interface ComposerSendOptions {
  /** Mode d'autorisation lu dans la préférence partagée au moment de l'envoi. */
  authorizationMode?: AuthorizationMode;
  /** Task 141 — agent dédié choisi pour ce tour (undefined = Gen IA). */
  agentId?: string;
  /** Task 141 — modèle IA choisi pour ce tour (undefined = automatique). */
  provider?: string;
  model?: string;
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
  /**
   * Étape 8 — pièce jointe injectée de l'extérieur (bouton « Éditer » d'une
   * image du fil) : l'image devient un attachment réel du prochain message,
   * avec un préfixe de texte optionnel (instruction d'édition).
   */
  injected?: { attachment: MessageAttachment; text?: string } | null;
  onInjectedConsumed?: () => void;
  /** Task 141 — agents actifs de l'utilisateur (sélecteur du composer). */
  agents?: ComposerAgentOption[];
  /** Agent dédié choisi pour le prochain message (undefined = Gen IA). */
  agentId?: string;
  onAgentChange?: (agentId: string | undefined) => void;
  /** Identifiant du moteur IA choisi (cf. lib/ui/composer-models). */
  modelId?: string;
  onModelIdChange?: (modelId: string | undefined) => void;
  /** Task 141 — texte injecté de l'extérieur (chips de suivi, « Réutiliser »). */
  prefill?: { text: string } | null;
  onPrefillConsumed?: () => void;
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
  injected = null,
  onInjectedConsumed,
  agents = [],
  agentId,
  onAgentChange,
  modelId,
  onModelIdChange,
  prefill = null,
  onPrefillConsumed,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  // Libellés lisibles des connecteurs déjà vus dans le sélecteur « @ » (état,
  // pas une ref : ils servent au rendu des puces activées).
  const [mentionLabels, setMentionLabels] = useState<Map<string, MentionItem>>(() => new Map());
  // Task 141 — menus pilotés par les commandes « /agent », « /modèle » et
  // « /moteur » (ouverture contrôlée des pills au-dessus du composer).
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  // Task 141 — glisser-déposer : compteur de profondeur (les événements
  // dragenter/dragleave se déclenchent sur CHAQUE enfant — le compteur
  // distingue l'entrée réelle du survol interne, l'overlay ne clignote pas).
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const composerRef = useRef<CommandComposerHandle | null>(null);

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus();
  }, [autoFocus]);

  // Étape 8 — consommation de l'injection externe (bouton « Éditer » d'une
  // image du fil) : l'image rejoint les attachments réels du prochain
  // message ; le préfixe d'édition pré-remplit le champ si vide.
  const injectedKey = injected ? `${injected.attachment.path ?? injected.attachment.url ?? ""}|${injected.text ?? ""}` : "";
  useEffect(() => {
    if (!injected) return;
    setAttachments((current) => {
      const key = injected.attachment.path ?? injected.attachment.url ?? injected.attachment.filename;
      const already = current.some((item) => (item.path ?? item.url ?? item.filename) === key);
      if (already) return current;
      if (current.length >= ATTACHMENT_MAX_FILES) return current;
      return [...current, injected.attachment];
    });
    if (injected.text) setValue((current) => (current.trim().length === 0 ? injected.text as string : current));
    onInjectedConsumed?.();
    composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectedKey]);

  // Task 141 — pré-remplissage externe (chip de suivi, « Réutiliser ») : le
  // texte s'ajoute À LA SUITE du brouillon en cours (rien n'est écrasé),
  // le curseur revient au composer.
  const prefillKey = prefill ? prefill.text : "";
  useEffect(() => {
    if (!prefill) return;
    const text = prefill.text.trim();
    if (text) {
      setValue((current) => (current.trim().length === 0 ? text : `${current}\n\n${text}`));
      composerRef.current?.focus();
    }
    onPrefillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);

  const uploadFile = async (file: File) => {
    setUploadError("");
    // Politique unifiée des pièces jointes : 10 fichiers × 50 Mo max.
    if (attachments.length >= ATTACHMENT_MAX_FILES) {
      setUploadError(attachmentLimitLabel());
      return;
    }
    const verdict = validateAttachment({ name: file.name, size: file.size });
    if (!verdict.ok) {
      setUploadError(verdict.reason);
      return;
    }
    setUploading(true);
    setUploadingName(file.name);
    try {
      // CANAL R2 (multipart présigné) : le fichier est déposé DIRECTEMENT
      // dans le stockage permanent — aucune limite de corps serverless — puis
      // converti côté serveur (CSV → lignes, JSON → structure, XLSX, DOCX,
      // HTML, PDF natif, texte) et stocké en base de données. Le contenu
      // converti accompagne ensuite le message — le modèle travaille sur le
      // contenu réel, pas sur un nom. Jusqu'à 50 Mo par fichier.
      const uploaded = await uploadPermanentFiles([file]);
      const stored = uploaded.uploaded[0];
      if (!stored || !stored.path) {
        throw new Error(uploaded.failed[0]?.error || "Téléversement impossible.");
      }
      const response = await authFetch("/api/files/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: stored.path,
          filename: stored.filename || file.name,
          contentType: stored.contentType || file.type || "application/octet-stream",
          sizeBytes: stored.sizeBytes || file.size,
          ...(projectId ? { projectId } : {}),
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Conversion du fichier impossible.");
      }
      const data = (await response.json()) as {
        file: { id: string; filename: string; kind: string; charCount: number; rowCount?: number; contentType: string; sizeBytes: number; conversion: string; path?: string };
      };
      setAttachments((current) => [
        ...current.slice(0, ATTACHMENT_MAX_FILES - 1),
        {
          filename: data.file.filename,
          fileId: data.file.id,
          fileKind: data.file.kind,
          charCount: data.file.charCount,
          // Étape 8 — les images importées portent leur clé R2 permanente :
          // elles deviennent une source réelle pour l'édition image-to-image.
          ...(data.file.path ? { path: data.file.path } : {}),
          ...(data.file.rowCount !== undefined ? { rowCount: data.file.rowCount } : {}),
          contentType: data.file.contentType,
          sizeBytes: data.file.sizeBytes,
        },
      ]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : `Envoi du fichier impossible (${Math.round(ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024))} Mo max par fichier).`);
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
    const modelChoice = findModelOption(modelId);
    await onSend(message, sent, {
      authorizationMode: readAuthorizationMode(),
      ...(agentId ? { agentId } : {}),
      ...(modelChoice?.provider ? { provider: modelChoice.provider, model: modelChoice.model } : {}),
    });
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

  /* « / » — commandes rapides : fichier, connecteurs, projet de contexte,
     agent, modèles de prompts, moteur IA (littéral unique + épandages,
     comme dans les autres chats Gen3ia). */
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
    ...(onAgentChange
      ? [
          {
            id: "agent",
            label: "Choisir l'agent qui répond",
            description: "Gen IA universel ou l'un de vos agents dédiés (persona, compétences, garde-fous).",
            run: () => setAgentMenuOpen(true),
          },
        ]
      : []),
    {
      id: "modeles",
      label: "Modèles de prompts",
      description: "Insérez une formulation réutilisable, ou enregistrez le brouillon actuel comme modèle.",
      run: () => setTemplateMenuOpen(true),
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

  /* Task 141 — glisser-déposer de fichiers : l'ENTIÈRE zone du composer est
     une zone de dépôt ; chaque fichier déposé passe par le MÊME canal que le
     bouton « + » (upload R2 + conversion réelle + garde 10 × 50 Mo). */
  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
  };
  const onDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const onDragLeave = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };
  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    for (const file of Array.from(event.dataTransfer.files)) void uploadFile(file);
  };

  return (
    <div
      className="relative space-y-2"
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Overlay de dépôt — feedback immédiat, ferme au relâchement. */}
      {dragActive && (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--g3-primary)] bg-[var(--g3-bg)]/85"
          role="status"
          aria-live="polite"
        >
          <p className="rounded-full border border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] px-4 py-2 text-xs font-semibold text-[var(--g3-primary-strong)]">
            Déposez vos fichiers — ils seront joints au prochain message
          </p>
        </div>
      )}

      {/* Task 141 — pills de pilotage : QUI répond (agent), avec QUEL moteur
          (modèle IA), et la bibliothèque de formulations (modèles). */}
      {(onAgentChange || onModelIdChange) && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Pilotage du prochain message">
          {onAgentChange && (
            <AgentPicker
              agents={agents}
              agentId={agentId}
              onChange={onAgentChange}
              disabled={disabled}
              open={agentMenuOpen}
              onOpenChange={setAgentMenuOpen}
            />
          )}
          <TemplateMenu
            onInsert={(body) => setValue((current) => (current.trim().length === 0 ? body : `${current}\n\n${body}`))}
            draft={value}
            disabled={disabled}
            open={templateMenuOpen}
            onOpenChange={setTemplateMenuOpen}
          />
        </div>
      )}

      {suggestions && suggestions.length > 0 && value === "" && attachments.length === 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggestions de départ">
          {suggestions.slice(0, 4).map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => setValue(suggestion)} className="g3-chip text-[11px]">
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {uploadError && <p className="text-[11px] text-[var(--g3-danger-strong)]" role="alert">{uploadError}</p>}

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pièces jointes">
          {attachments.map((attachment, index) => (
            <li key={`${attachment.filename}-${index}`} className="g3-chip !py-1 text-[11px]">
              <span aria-hidden>📎</span>
              <span className="max-w-[220px] truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                className="text-[var(--g3-faint)] hover:text-[var(--g3-danger-strong)]"
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
