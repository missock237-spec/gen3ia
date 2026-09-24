"use client";

import * as React from "react";
import Image from "next/image";

type Tool = {
  id: string;
  name: string;
  description: string;
};

export const AGENT_TOOLS: Tool[] = [
  { id: "web.search", name: "Recherche web", description: "Recherche des informations récentes sur le web." },
  { id: "file.read", name: "Fichiers", description: "Analyse les fichiers autorisés de votre espace." },
  { id: "zip.analyze", name: "ZIP", description: "Inspecte une archive ZIP en environnement contrôlé." },
  { id: "artifact.create", name: "Documents", description: "Crée un document ou un artefact persistant." },
  { id: "code.execute", name: "Code isolé", description: "Exécute du code dans le sandbox Gen3ia." },
  { id: "memory.read", name: "Mémoire", description: "Utilise la mémoire persistante autorisée." },
  { id: "composio.execute", name: "Applications", description: "Exécute une action sur une application connectée, avec autorisation." },
  { id: "camera.capture", name: "Caméra", description: "Demande une capture après autorisation explicite." },
];

const PlusIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}><path d="M12 5v14M5 12h14" strokeLinecap="round"/></svg>;
const SendIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="m4 4 16 8-16 8 3-8-3-8Z" strokeLinejoin="round"/><path d="M7 12h13" strokeLinecap="round"/></svg>;
const MicIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M9 22h6" strokeLinecap="round"/></svg>;
const SlidersIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/></svg>;
const XIcon = (props: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}><path d="m6 6 12 12M18 6 6 18" strokeLinecap="round"/></svg>;

export interface PromptBoxProps {
  value?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
  placeholder?: string;
  selectedTool?: string | null;
  onToolChange?: (tool: string | null) => void;
  onFile?: (file: File) => void;
  onVoice?: () => void;
  className?: string;
}

export const PromptBox = React.forwardRef<HTMLTextAreaElement, PromptBoxProps>(
  ({ value = "", onValueChange, onSubmit, disabled = false, placeholder = "Décrivez ce que vous voulez que Gen3ia fasse…", selectedTool = null, onToolChange, onFile, onVoice, className = "" }, ref) => {
    const [localValue, setLocalValue] = React.useState(value);
    const [open, setOpen] = React.useState(false);
    const [preview, setPreview] = React.useState<string | null>(null);
    const fileRef = React.useRef<HTMLInputElement>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const controlled = onValueChange !== undefined;
    const current = controlled ? value : localValue;

    React.useImperativeHandle(ref, () => textareaRef.current as HTMLTextAreaElement);
    React.useEffect(() => setLocalValue(value), [value]);

    React.useEffect(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.style.height = "0px";
      node.style.height = Math.min(node.scrollHeight, 220) + "px";
    }, [current]);

    const update = (next: string) => {
      if (!controlled) setLocalValue(next);
      onValueChange?.(next);
    };

    const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/") && !file.type.includes("pdf") && !file.type.includes("zip")) return;
      if (file.size > 20 * 1024 * 1024) return;
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => setPreview(String(reader.result));
        reader.readAsDataURL(file);
      }
      onFile?.(file);
      event.target.value = "";
    };

    const active = AGENT_TOOLS.find((tool) => tool.id === selectedTool);
    const canSend = !disabled && (current.trim().length > 0 || Boolean(preview));

    return (
      <form onSubmit={onSubmit} className={`relative rounded-[26px] border border-[var(--g3-border)] bg-white p-2 shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)] transition-all duration-300 focus-within:border-neutral-300 focus-within:shadow-[0_14px_40px_-18px_rgba(28,27,24,0.28)] ${className}`}>
        <input ref={fileRef} type="file" className="hidden" accept="image/*,.pdf,.zip" onChange={handleFile} />
        {preview && (
          <div className="mb-1 flex items-center gap-2 rounded-2xl bg-neutral-50 p-2">
            <Image src={preview} alt="Aperçu de la pièce jointe" width={48} height={48} unoptimized className="h-12 w-12 rounded-xl object-cover" />
            <span className="text-xs text-neutral-500">Image jointe</span>
            <button type="button" onClick={() => setPreview(null)} className="ml-auto rounded-full p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label="Retirer la pièce jointe"><XIcon className="h-4 w-4"/></button>
          </div>
        )}

        {active && (
          <div className="mb-1 flex items-center gap-2 px-2 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-100 px-2.5 py-1 text-[11px] text-sky-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />{active.name}
            </span>
            <button type="button" onClick={() => onToolChange?.(null)} className="text-neutral-400 hover:text-neutral-900" aria-label="Retirer l'outil"><XIcon className="h-3.5 w-3.5"/></button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          name="message"
          value={current}
          rows={1}
          maxLength={20000}
          disabled={disabled}
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSend) event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
          className="max-h-[220px] min-h-14 w-full resize-none border-0 bg-transparent px-3 py-3 text-[15px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400 disabled:opacity-50"
        />

        <div className="flex items-center gap-1.5 px-1 pb-1">
          <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()} className="grid h-9 w-9 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30" aria-label="Joindre un fichier"><PlusIcon className="h-5 w-5"/></button>
          <div className="relative">
            <button type="button" disabled={disabled} onClick={() => setOpen((v) => !v)} className="flex h-9 items-center gap-2 rounded-full px-3 text-xs font-medium text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900" aria-expanded={open}><SlidersIcon className="h-4 w-4"/><span className="hidden sm:inline">Capacités</span></button>
            {open && (
              <div className="absolute bottom-11 left-0 z-50 w-[280px] overflow-hidden rounded-2xl border border-[var(--g3-border)] bg-white p-2 shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)] anim-scale-in">
                <div className="px-2 py-2 text-[10px] font-bold uppercase tracking-[.2em] text-neutral-400">Outil prioritaire</div>
                {AGENT_TOOLS.map((tool) => (
                  <button key={tool.id} type="button" onClick={() => { onToolChange?.(tool.id); setOpen(false); }} className="flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition hover:bg-neutral-100">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sky-100 text-sky-700">•</span>
                    <span><span className="block text-xs font-semibold text-neutral-800">{tool.name}</span><span className="mt-0.5 block text-[10px] leading-4 text-neutral-400">{tool.description}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="hidden text-[10px] text-neutral-400 md:block">Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" disabled={disabled} onClick={onVoice} className="grid h-9 w-9 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30" aria-label="Voix"><MicIcon className="h-4.5 w-4.5"/></button>
            <button type="submit" disabled={!canSend} className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white shadow-lg shadow-neutral-900/15 transition hover:scale-105 hover:bg-neutral-800 disabled:scale-100 disabled:cursor-not-allowed disabled:opacity-30" aria-label="Envoyer"><SendIcon className="h-4.5 w-4.5"/></button>
          </div>
        </div>
      </form>
    );
  }
);
PromptBox.displayName = "PromptBox";
