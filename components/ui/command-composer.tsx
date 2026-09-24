"use client";

import * as React from "react";

import {
  AUTHORIZATION_MODES,
  AUTHORIZATION_MODE_STORAGE_KEY,
  DEFAULT_AUTHORIZATION_MODE,
  authorizationModeLabel,
  type AuthorizationMode,
} from "@/lib/security/authorization-mode";
import {
  detectCommandQuery,
  detectMentionQuery,
  filterCommands,
  moveHighlight,
  stripTrigger,
  type ComposerCommand,
  type MentionItem,
} from "@/lib/ui/command-composer-helpers";

/**
 * CommandComposer — barre de commande d'agent IA unifiée, identique dans
 * tous les chats Gen3ia (chat d'agent IA du Studio).
 *
 * Réplique fidèle de la maquette validée :
 *  - grande zone de texte anthracite fortement arrondie sur fond sombre ;
 *  - placeholder « Posez n'importe quelle question… Tapez @ pour mentionner
 *    des compétences ou connecteurs, ou / pour les commandes » ;
 *  - bouton « + » (pièce jointe ou ajout de source) à gauche ;
 *  - sélecteur de mode d'autorisation « Toujours demander ▼ » au centre
 *    (Toujours demander / Demander si nécessaire / Autoriser automatiquement) ;
 *  - microphone (saisie vocale fr-FR) puis bouton circulaire « ↑ » à droite.
 */

const PlusIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>;
const ArrowUpIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...props}><path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const ChevronDownIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const MicIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4M9 22h6" strokeLinecap="round" /></svg>;
const FileIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" strokeLinejoin="round" /><path d="M14 2v6h6" strokeLinejoin="round" /></svg>;
const XIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" /></svg>;
const StopIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...props}><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;

export interface CommandComposerHandle {
  focus: () => void;
  openMentions: () => void;
  openCommands: () => void;
  openFilePicker: () => void;
}

export interface CommandComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
  /** Nombre maximum de caractères du message. */
  maxLength?: number;
  /** Texte indicatif — identique dans tous les chats par défaut. */
  placeholder?: string;
  /** Charge les connecteurs mentionnables via « @ » (API /api/integrations/mention). */
  loadMentions?: (query: string) => Promise<MentionItem[]>;
  /** Connecteurs déjà activés (affichés en puces sous le texte). */
  activatedMentions?: MentionItem[];
  onActivateMention?: (item: MentionItem) => void;
  onDeactivateMention?: (toolkit: string) => void;
  /** Commandes rapides accessibles via « / ». */
  commands?: ComposerCommand[];
  /** Action du bouton « + » : pièce jointe (défaut) ou menu des sources connectées. */
  plusAction?: "file" | "mentions";
  /** Accept du sélecteur de fichiers (défaut : image, PDF, ZIP). */
  fileAccept?: string;
  /** Appelé quand un fichier est choisi (le téléversement reste côté parent). */
  onFile?: (file: File) => void;
  /** Pièce jointe en cours (nom affiché en puce, null = aucune). */
  attachmentName?: string | null;
  attachmentUploading?: boolean;
  onRemoveAttachment?: () => void;
  /** Mode d'autorisation contrôlé — sinon auto-géré (persisté en localStorage). */
  authorizationMode?: AuthorizationMode;
  onAuthorizationModeChange?: (mode: AuthorizationMode) => void;
  className?: string;
}

export const CommandComposer = React.forwardRef<CommandComposerHandle, CommandComposerProps>(
  function CommandComposer({
    value,
    onValueChange,
    onSubmit,
    disabled = false,
    maxLength = 20_000,
    placeholder = "Posez n'importe quelle question… Tapez @ pour mentionner des compétences ou connecteurs, ou / pour les commandes",
    loadMentions,
    activatedMentions = [],
    onActivateMention,
    onDeactivateMention,
    commands = [],
    plusAction = "file",
    fileAccept = "image/*,.pdf,.zip,.txt,.md,.csv,.json,.doc,.docx",
    onFile,
    attachmentName = null,
    attachmentUploading = false,
    onRemoveAttachment,
    authorizationMode,
    onAuthorizationModeChange,
    className = "",
  }, ref) {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const fileRef = React.useRef<HTMLInputElement>(null);
    const [mode, setMode] = React.useState<AuthorizationMode>(authorizationMode ?? DEFAULT_AUTHORIZATION_MODE);
    const [modeMenuOpen, setModeMenuOpen] = React.useState(false);

    // Menus « @ » et « / »
    const [mentionMenuOpen, setMentionMenuOpen] = React.useState(false);
    const [mentionQuery, setMentionQuery] = React.useState("");
    const [mentionItems, setMentionItems] = React.useState<MentionItem[]>([]);
    const [mentionLoading, setMentionLoading] = React.useState(false);
    const [mentionHighlight, setMentionHighlight] = React.useState(0);
    const [commandMenuOpen, setCommandMenuOpen] = React.useState(false);
    const [commandHighlight, setCommandHighlight] = React.useState(0);

    // Saisie vocale
    const [isListening, setIsListening] = React.useState(false);
    const [voiceError, setVoiceError] = React.useState("");

    const controlledMode = onAuthorizationModeChange !== undefined;
    const activeMode = controlledMode ? (authorizationMode ?? DEFAULT_AUTHORIZATION_MODE) : mode;

    // Persistance locale de la préférence (tous chats confondus).
    React.useEffect(() => {
      if (controlledMode) return;
      try {
        const stored = window.localStorage.getItem(AUTHORIZATION_MODE_STORAGE_KEY);
        if (stored === "always_ask" || stored === "ask_if_needed" || stored === "auto_allow") setMode(stored);
      } catch { /* localStorage indisponible */ }
    }, [controlledMode]);

    const applyMode = (next: AuthorizationMode) => {
      if (!controlledMode) {
        setMode(next);
        try { window.localStorage.setItem(AUTHORIZATION_MODE_STORAGE_KEY, next); } catch { /* stockage indisponible */ }
      }
      onAuthorizationModeChange?.(next);
    };

    React.useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      openMentions: () => { setCommandMenuOpen(false); setMentionMenuOpen(true); setMentionQuery(""); setMentionHighlight(0); },
      openCommands: () => { setMentionMenuOpen(false); setCommandMenuOpen(true); setCommandHighlight(0); },
      openFilePicker: () => fileRef.current?.click(),
    }));

    // Croissance automatique de la zone de texte.
    React.useEffect(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.style.height = "0px";
      node.style.height = Math.min(Math.max(node.scrollHeight, 64), 220) + "px";
    }, [value]);

    // Détection des déclencheurs en fin de saisie.
    const mentionMatch = detectMentionQuery(value);
    const commandMatch = detectCommandQuery(value);

    React.useEffect(() => {
      // Comparaisons explicites à null : une requête vide ("@" ou "/" nu)
      // est un match valide et doit ouvrir le menu.
      if (mentionMatch === null || commandMatch !== null) {
        if (!mentionMenuOpen) return;
        setMentionMenuOpen(false);
        setMentionQuery("");
        return;
      }
      setCommandMenuOpen(false);
      setModeMenuOpen(false);
      setMentionMenuOpen(true);
      setMentionQuery(mentionMatch);
      setMentionHighlight(0);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- mentionMenuOpen volontairement hors dépendances : fermeture seulement
    }, [mentionMatch, commandMatch]);

    React.useEffect(() => {
      if (commandMatch !== null) {
        setMentionMenuOpen(false);
        setModeMenuOpen(false);
        setCommandMenuOpen(true);
        setCommandHighlight(0);
      } else if (commandMenuOpen) {
        setCommandMenuOpen(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- commandMenuOpen hors dépendances : fermeture seulement
    }, [commandMatch]);

    // Chargement des connecteurs mentionnables (debounce 180 ms).
    React.useEffect(() => {
      if (!mentionMenuOpen || !loadMentions) return;
      let cancelled = false;
      const timer = setTimeout(async () => {
        setMentionLoading(true);
        try {
          const items = await loadMentions(mentionQuery);
          if (!cancelled) setMentionItems(Array.isArray(items) ? items : []);
        } catch {
          if (!cancelled) setMentionItems([]);
        } finally {
          if (!cancelled) setMentionLoading(false);
        }
      }, 180);
      return () => { cancelled = true; clearTimeout(timer); };
    }, [mentionMenuOpen, mentionQuery, loadMentions]);

    const visibleCommands = React.useMemo(
      () => filterCommands(commands, commandMatch ?? ""),
      [commands, commandMatch],
    );

    const closeMenus = () => {
      setMentionMenuOpen(false);
      setCommandMenuOpen(false);
      setMentionQuery("");
    };

    const chooseMention = (item: MentionItem) => {
      onActivateMention?.(item);
      if (mentionMatch !== null) onValueChange(stripTrigger(value, "@"));
      closeMenus();
      textareaRef.current?.focus();
    };

    const chooseCommand = (command: ComposerCommand) => {
      if (commandMatch !== null) onValueChange(stripTrigger(value, "/"));
      closeMenus();
      command.run();
      textareaRef.current?.focus();
    };

    const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      onFile?.(file);
      event.target.value = "";
    };

    // La voix concatène la valeur À JOUR : onValueChange du parent reçoit le
    // texte complet (valeur courante lue via valueRef, jamais un état périmé).
    const valueRef = React.useRef(value);
    React.useEffect(() => { valueRef.current = value; }, [value]);
    function startVoice() {
      type Recognition = {
        lang: string; continuous: boolean; interimResults: boolean;
        start: () => void; stop: () => void;
        onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onend: (() => void) | null;
        onerror: (() => void) | null;
      };
      type RecognitionConstructor = new () => Recognition;
      const speechWindow = window as unknown as {
        SpeechRecognition?: RecognitionConstructor;
        webkitSpeechRecognition?: RecognitionConstructor;
      };
      const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        setVoiceError("La saisie vocale n'est pas disponible dans ce navigateur.");
        setTimeout(() => setVoiceError(""), 4000);
        return;
      }
      const recognition = new SpeechRecognition();
      recognition.lang = "fr-FR";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join(" ").trim();
        if (!transcript) return;
        onValueChange(valueRef.current ? `${valueRef.current} ${transcript}` : transcript);
      };
      recognition.onend = () => setIsListening(false);
      recognition.onerror = () => {
        setIsListening(false);
        setVoiceError("La saisie vocale a rencontré un problème. Réessayez.");
        setTimeout(() => setVoiceError(""), 4000);
      };
      setIsListening(true);
      recognition.start();
    }

    const canSend = !disabled && value.trim().length > 0;

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionMenuOpen) {
        if (event.key === "ArrowDown") { event.preventDefault(); setMentionHighlight((index) => moveHighlight(index, 1, mentionItems.length)); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setMentionHighlight((index) => moveHighlight(index, -1, mentionItems.length)); return; }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = mentionItems[mentionHighlight];
          if (item) { event.preventDefault(); chooseMention(item); }
          return;
        }
        if (event.key === "Escape") { event.preventDefault(); closeMenus(); return; }
      }
      if (commandMenuOpen) {
        if (event.key === "ArrowDown") { event.preventDefault(); setCommandHighlight((index) => moveHighlight(index, 1, visibleCommands.length)); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setCommandHighlight((index) => moveHighlight(index, -1, visibleCommands.length)); return; }
        if (event.key === "Enter" || event.key === "Tab") {
          const command = visibleCommands[commandHighlight];
          if (command) { event.preventDefault(); chooseCommand(command); }
          return;
        }
        if (event.key === "Escape") { event.preventDefault(); closeMenus(); return; }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (canSend) event.currentTarget.form?.requestSubmit();
      }
    };

    const showModeMenu = modeMenuOpen && !disabled;

    return (
      <form
        onSubmit={onSubmit}
        className={"relative rounded-[28px] border border-white/10 bg-[var(--g3-elevated)] p-2.5 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.85)] transition-colors duration-300 focus-within:border-white/20 " + className}
        aria-label="Barre de commande IA"
      >
        <input ref={fileRef} type="file" className="hidden" accept={fileAccept} onChange={handleFile} />

        {/* Puces : pièce jointe + connecteurs activés */}
        {(attachmentName || activatedMentions.length > 0) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1 pt-1" aria-label="Contextes actifs">
            {attachmentName && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[var(--g3-surface)]/5 px-2.5 py-1 text-[11px] text-[var(--g3-text-secondary)]">
                <FileIcon className="h-3.5 w-3.5 text-[var(--g3-faint)]" aria-hidden="true" />
                <span className="max-w-[180px] truncate">{attachmentUploading ? "Téléversement…" : attachmentName}</span>
                {onRemoveAttachment && (
                  <button type="button" onClick={onRemoveAttachment} className="rounded-full p-0.5 text-[var(--g3-muted)] hover:bg-[var(--g3-surface)]/10 hover:text-[var(--g3-text-secondary)]" aria-label="Retirer la pièce jointe">
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </span>
            )}
            {activatedMentions.map((item) => (
              <span key={item.toolkit} className={"inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] " + (item.connected === false ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-white/10 bg-[var(--g3-surface)]/5 text-[var(--g3-text-secondary)]")}>
                <span aria-hidden="true" className="font-semibold text-[var(--g3-faint)]">@</span>
                {item.label}
                <button type="button" onClick={() => onDeactivateMention?.(item.toolkit)} className="rounded-full p-0.5 text-[var(--g3-muted)] hover:bg-[var(--g3-surface)]/10 hover:text-[var(--g3-text-secondary)]" aria-label={`Retirer ${item.label}`}>
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Zone de texte principale */}
        <textarea
          ref={textareaRef}
          name="message"
          value={value}
          rows={2}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="min-h-16 w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2 text-[15px] leading-6 text-[var(--g3-text-secondary)] outline-none placeholder:text-[var(--g3-faint)] disabled:opacity-50"
          aria-label="Message pour l'IA"
        />

        {/* Barre d'outils : + | mode d'autorisation | 🎙 ↑ */}
        <div className="flex items-center gap-1 px-1 pb-0.5 pt-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => (plusAction === "mentions" ? (setCommandMenuOpen(false), setMentionMenuOpen(true), setMentionQuery("")) : fileRef.current?.click())}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--g3-faint)] transition hover:bg-[var(--g3-surface)]/10 hover:text-white disabled:opacity-30"
            aria-label={plusAction === "mentions" ? "Ajouter une source connectée" : "Joindre un fichier"}
          >
            <PlusIcon className="h-5 w-5" />
          </button>

          {/* Sélecteur « Toujours demander ▼ » */}
          <div className="relative flex flex-1 justify-center">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setModeMenuOpen((current) => !current)}
              aria-expanded={showModeMenu}
              aria-haspopup="listbox"
              className="flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-[var(--g3-surface)]/5 px-3.5 text-xs font-medium text-[var(--g3-faint)] transition hover:bg-[var(--g3-surface)]/10 hover:text-white disabled:opacity-30"
            >
              {authorizationModeLabel(activeMode)}
              <ChevronDownIcon className={"h-3.5 w-3.5 transition-transform " + (showModeMenu ? "rotate-180" : "")} />
            </button>
            {showModeMenu && (
              <div className="absolute bottom-11 left-1/2 z-50 w-[300px] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 bg-[var(--g3-elevated)] p-1.5 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)]" role="listbox" aria-label="Mode d'autorisation des actions de l'agent">
                {AUTHORIZATION_MODES.map((option) => {
                  const selected = option.id === activeMode;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => { applyMode(option.id); setModeMenuOpen(false); }}
                      className={"flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition " + (selected ? "bg-[var(--g3-surface)]/10" : "hover:bg-[var(--g3-surface)]/5")}
                    >
                      <span className={"mt-1 h-2 w-2 shrink-0 rounded-full " + (selected ? "bg-[var(--g3-surface)]" : "bg-neutral-600")} aria-hidden="true" />
                      <span>
                        <span className="block text-xs font-semibold text-[var(--g3-text-secondary)]">{option.label}</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-[var(--g3-faint)]">{option.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {voiceError && <span className="absolute -top-8 right-2 rounded-full border border-white/10 bg-[var(--g3-elevated)] px-3 py-1 text-[10px] text-[var(--g3-faint)]" role="status">{voiceError}</span>}

          <button
            type="button"
            disabled={disabled}
            onClick={startVoice}
            className={"grid h-10 w-10 shrink-0 place-items-center rounded-full transition disabled:opacity-30 " + (isListening ? "bg-[var(--g3-surface)]/15 text-white" : "text-[var(--g3-faint)] hover:bg-[var(--g3-surface)]/10 hover:text-white")}
            aria-label={isListening ? "Saisie vocale en cours" : "Saisie vocale"}
            aria-pressed={isListening}
          >
            {isListening ? <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-400" aria-hidden="true" /> : <MicIcon className="h-5 w-5" />}
          </button>

          <button
            type="submit"
            disabled={!canSend}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--g3-surface)] text-[var(--g3-text)] shadow-[0_6px_18px_-6px_rgba(255,255,255,0.35)] transition hover:scale-105 disabled:scale-100 disabled:cursor-not-allowed disabled:bg-[var(--g3-elevated)] disabled:text-[var(--g3-muted)] disabled:shadow-none"
            aria-label="Envoyer"
          >
            <ArrowUpIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Menu « / » — commandes rapides */}
        {commandMenuOpen && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[var(--g3-elevated)] p-1.5 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)]" role="listbox" aria-label="Commandes rapides">
            <p className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-muted)]">Commandes</p>
            {visibleCommands.length === 0 ? (
              <p className="px-3 py-3 text-xs text-[var(--g3-faint)]">Aucune commande ne correspond.</p>
            ) : (
              visibleCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={index === commandHighlight}
                  onClick={() => chooseCommand(command)}
                  onMouseEnter={() => setCommandHighlight(index)}
                  className={"flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition " + (index === commandHighlight ? "bg-[var(--g3-surface)]/10" : "hover:bg-[var(--g3-surface)]/5")}
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--g3-surface)]/5 text-xs font-bold text-[var(--g3-faint)]" aria-hidden="true">/</span>
                  <span>
                    <span className="block text-xs font-semibold text-[var(--g3-text-secondary)]">{command.label}</span>
                    {command.description && <span className="mt-0.5 block text-[10px] leading-4 text-[var(--g3-faint)]">{command.description}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Menu « @ » — compétences et connecteurs */}
        {mentionMenuOpen && loadMentions && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[var(--g3-elevated)] p-1.5 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)]" role="listbox" aria-label="Mentionner une compétence ou un connecteur">
            <div className="flex items-center justify-between px-2.5 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-muted)]">Compétences &amp; connecteurs</p>
              <button type="button" onClick={closeMenus} className="rounded-full p-1 text-[var(--g3-muted)] hover:bg-[var(--g3-surface)]/10 hover:text-[var(--g3-text-secondary)]" aria-label="Fermer le sélecteur">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {mentionLoading && mentionItems.length === 0 ? (
                <p className="px-3 py-3 text-xs text-[var(--g3-faint)]">Chargement…</p>
              ) : mentionItems.length === 0 ? (
                <p className="px-3 py-3 text-xs text-[var(--g3-faint)]">Aucune compétence ou connecteur ne correspond.</p>
              ) : (
                mentionItems.map((item, index) => {
                  const alreadyActive = activatedMentions.some((active) => active.toolkit === item.toolkit);
                  return (
                    <button
                      key={item.toolkit}
                      type="button"
                      role="option"
                      aria-selected={index === mentionHighlight}
                      disabled={alreadyActive}
                      onClick={() => chooseMention(item)}
                      onMouseEnter={() => setMentionHighlight(index)}
                      className={"flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition disabled:opacity-40 " + (index === mentionHighlight && !alreadyActive ? "bg-[var(--g3-surface)]/10" : "hover:bg-[var(--g3-surface)]/5")}
                    >
                      <span className={"mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-bold " + (item.connected === false ? "bg-amber-500/10 text-amber-300" : "bg-[var(--g3-surface)]/5 text-[var(--g3-faint)]")} aria-hidden="true">@</span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--g3-text-secondary)]">
                          {item.label}
                          {item.connected === false && <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-amber-300">à connecter</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] leading-4 text-[var(--g3-faint)]">{item.description}</span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </form>
    );
  },
);
