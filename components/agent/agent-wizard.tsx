"use client";

import * as React from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import { Callout } from "@/components/studio/callout";
import { WIZARD_AGENT_TYPES, wizardTypeForKey, type WizardAgentType } from "@/lib/agents/charter";
import type { AgentSummary } from "@/lib/agents/schema";

/**
 * Assistant de personnalisation d'un agent IA (Studio Gen3ia).
 * La personnalisation est OBLIGATOIRE avant toute exécution de tâche :
 * nom, description, compétences, fichier mémoire (optionnel), nature
 * (agent d'appel ou standard) et type d'agent (prédéfini ou personnalisé).
 * Sans prompt système saisi, la charte professionnelle est générée
 * automatiquement côté serveur.
 */

const MEMORY_FILE_ACCEPT = ".txt,.md,.json,.csv,.pdf,.zip,.doc,.docx,.xls,.xlsx,image/*";
const MEMORY_MAX_BYTES = 20 * 1024 * 1024;

interface AgentWizardProps {
  /** Agent à modifier (mode édition) ou null (création). */
  editing?: AgentSummary | null;
  onSaved: (agent: AgentSummary) => void;
  onCancel: () => void;
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="g3-chip" data-selected={selected} aria-pressed={selected} onClick={onClick}>
      {label}
    </button>
  );
}

export function AgentWizard({ editing = null, onSaved, onCancel }: AgentWizardProps) {
  const sessionDisponible = useSessionAvailable();
  const [name, setName] = React.useState(editing?.name ?? "");
  const [description, setDescription] = React.useState(editing?.description ?? "");
  const [skills, setSkills] = React.useState<string[]>(editing?.skills ?? []);
  const [skillDraft, setSkillDraft] = React.useState("");
  const [wizardKey, setWizardKey] = React.useState<string>(() => {
    if (!editing) return "code";
    const match = WIZARD_AGENT_TYPES.find((entry) => entry.baseType === editing.type && entry.label === editing.typeLabel);
    if (match) return match.key;
    if (editing.typeLabel) return "custom";
    return WIZARD_AGENT_TYPES.find((entry) => entry.baseType === editing.type)?.key ?? "universal";
  });
  const [customType, setCustomType] = React.useState(editing?.typeLabel ?? "");
  const [agentMode, setAgentMode] = React.useState<"standard" | "call">(editing?.agentMode ?? "standard");
  const [memoryFile, setMemoryFile] = React.useState<{ path: string; name: string } | null>(editing?.memoryFile ?? null);
  const [memoryUploading, setMemoryUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const selectedType: WizardAgentType = wizardTypeForKey(wizardKey) ?? WIZARD_AGENT_TYPES[5];
  const isCustom = selectedType.key === "custom";
  const effectiveLabel = isCustom ? customType.trim() : selectedType.label;

  const suggestions = selectedType.suggestedSkills.filter((skill) => !skills.includes(skill));

  const addSkill = (value: string) => {
    const skill = value.trim().slice(0, 80);
    if (!skill || skills.includes(skill) || skills.length >= 12) return;
    setSkills((current) => [...current, skill]);
    setSkillDraft("");
  };

  const handleMemoryFile = async (file: File) => {
    setError("");
    if (file.size > MEMORY_MAX_BYTES) {
      setError("Le fichier mémoire doit peser moins de 20 Mo.");
      return;
    }
    setMemoryUploading(true);
    try {
      const result = await uploadPermanentFiles([file]);
      const uploaded = result.uploaded[0];
      if (!uploaded) throw new Error(result.failed[0]?.error || "Téléversement impossible.");
      const path = uploaded.path || uploaded.filename;
      if (!path) throw new Error("Le stockage n'a pas retourné le chemin du fichier.");
      setMemoryFile({ path, name: uploaded.filename || file.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le fichier mémoire n'a pas pu être téléversé.");
    } finally {
      setMemoryUploading(false);
    }
  };

  const canSubmit =
    name.trim().length >= 2 &&
    description.trim().length >= 10 &&
    skills.length >= 1 &&
    (!isCustom || customType.trim().length >= 2) &&
    !memoryUploading;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    if (sessionDisponible === false) {
      setError("Session expirée. Reconnectez-vous.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        type: selectedType.baseType,
        typeLabel: effectiveLabel,
        skills,
        agentMode,
        memoryFile: memoryFile ?? undefined,
        tools: selectedType.declaredTools,
        status: "active" as const,
        voiceEnabled: agentMode === "call",
        ...(agentMode === "call"
          ? {
              voiceConfig: {
                language: "fr-FR" as const,
                greeting: `Bonjour, je suis ${name.trim()}. Comment puis-je vous aider ?`,
                maxTurns: 20,
                maxDurationSeconds: 300,
                inboundEnabled: true,
                outboundEnabled: true,
                voiceEnabled: true,
              },
            }
          : {}),
      };
      const response = await authFetch(editing ? `/api/agents/${editing.id}` : "/api/agents", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? (editing ? "Mise à jour impossible." : "Création impossible."));
      onSaved(data.agent as AgentSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : (editing ? "Mise à jour impossible." : "Création impossible."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="g3-card anim-slide-up p-5 md:p-7" aria-label="Assistant de personnalisation de l'agent">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold md:text-xl">{editing ? "Personnaliser l'agent" : "Personnalisez votre agent IA"}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
            Avant d&apos;exécuter une tâche, configurez votre agent : identité, compétences, mémoire, nature et type.
            Sa charte professionnelle et son périmètre strict sont générés automatiquement — il ne sortira jamais de son domaine.
          </p>
        </div>
        <span className="rounded-full border border-sky-200 bg-sky-100 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-700">Étape obligatoire</span>
      </div>

      {error && <Callout tone="error" className="mt-4 rounded-2xl">{error}</Callout>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Colonne 1 : identité + compétences */}
        <div className="space-y-5">
          <div>
            <label className="g3-label" htmlFor="wizard-name">Nom de l&apos;agent *</label>
            <input id="wizard-name" className="g3-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Nexus, CodeMaster, MarketingPro…" maxLength={80} required minLength={2} />
          </div>

          <div>
            <label className="g3-label" htmlFor="wizard-desc">Description (mission) *</label>
            <textarea id="wizard-desc" className="g3-textarea min-h-24" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex. Agent développeur senior spécialisé en applications web React et Next.js. Il écrit, corrige et documente du code." maxLength={500} required minLength={10} />
            <p className="mt-1 text-xs text-neutral-400">{description.trim().length} / 500 caractères — cette description ancre l&apos;agent dans sa mission.</p>
          </div>

          <div>
            <label className="g3-label" htmlFor="wizard-skill">Compétences * <span className="font-normal text-neutral-400">(une ou plusieurs, 12 maximum)</span></label>
            <div className="flex gap-2">
              <input
                id="wizard-skill"
                className="g3-input flex-1"
                value={skillDraft}
                onChange={(e) => setSkillDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSkill(skillDraft);
                  }
                }}
                placeholder="Ex. React, SEO, veille concurrentielle…"
                maxLength={80}
              />
              <button type="button" className="g3-btn g3-btn-ghost" onClick={() => addSkill(skillDraft)} disabled={!skillDraft.trim() || skills.length >= 12}>
                Ajouter
              </button>
            </div>
            {suggestions.length > 0 && (
              <div className="mt-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Suggestions {selectedType.label}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {suggestions.slice(0, 6).map((skill) => (
                    <Chip key={skill} label={`+ ${skill}`} onClick={() => addSkill(skill)} />
                  ))}
                </div>
              </div>
            )}
            {skills.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {skills.map((skill) => (
                  <span key={skill} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                    {skill}
                    <button type="button" onClick={() => setSkills((current) => current.filter((item) => item !== skill))} aria-label={`Retirer ${skill}`} className="text-emerald-500 hover:text-emerald-800">×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <span className="g3-label">Fichier mémoire <span className="font-normal text-neutral-400">(optionnel)</span></span>
            {memoryFile ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-emerald-800">{memoryFile.name}</p>
                  <p className="text-xs text-emerald-600">L&apos;agent s&apos;appuiera sur ce fichier comme référence de confiance.</p>
                </div>
                <button type="button" className="g3-btn g3-btn-ghost !px-3 !py-2 text-xs" onClick={() => setMemoryFile(null)}>Retirer</button>
              </div>
            ) : (
              <>
                <input
                  type="file"
                  accept={MEMORY_FILE_ACCEPT}
                  className="block w-full cursor-pointer rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-3 py-2.5 text-sm text-neutral-600 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-neutral-800"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void handleMemoryFile(file);
                  }}
                  aria-label="Fichier mémoire de l'agent"
                />
                <p className="mt-1 text-xs text-neutral-400">{memoryUploading ? "Téléversement en cours…" : "Documents, notes de contexte, bases de connaissances (20 Mo max). L'agent le consultera automatiquement."}</p>
              </>
            )}
          </div>
        </div>

        {/* Colonne 2 : nature + type */}
        <div className="space-y-5">
          <div>
            <span className="g3-label">Nature de l&apos;agent *</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                { key: "standard", title: "Agent standard", detail: "Travaille dans le chat Gen3ia : réponses et exécutions écrites." },
                { key: "call", title: "Agent d'appel", detail: "Conçu pour la voix et le téléphone — configuration vocale juste après création." },
              ] as const).map((option) => {
                const selected = agentMode === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setAgentMode(option.key)}
                    aria-pressed={selected}
                    className={`rounded-xl border p-3.5 text-left transition-all duration-300 ${selected ? "border-neutral-900 bg-neutral-50 shadow-[0_8px_24px_-12px_rgba(28,27,24,0.35)]" : "border-[rgba(23,23,20,0.09)] bg-white hover:border-neutral-300 hover:bg-neutral-50"}`}
                  >
                    <span className="block text-sm font-bold">{option.title}</span>
                    <span className="mt-1 block text-xs leading-5 text-neutral-500">{option.detail}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span className="g3-label">Type d&apos;agent *</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {WIZARD_AGENT_TYPES.map((entry) => {
                const selected = wizardKey === entry.key;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setWizardKey(entry.key)}
                    aria-pressed={selected}
                    className={`rounded-xl border p-3 text-left transition-all duration-300 ${selected ? "border-neutral-900 bg-neutral-50 shadow-[0_8px_24px_-12px_rgba(28,27,24,0.35)]" : "border-[rgba(23,23,20,0.09)] bg-white hover:border-neutral-300 hover:bg-neutral-50"}`}
                  >
                    <span className="block text-sm font-semibold">{entry.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-neutral-500">{entry.description}</span>
                  </button>
                );
              })}
            </div>
            {isCustom && (
              <div className="anim-fade-in mt-3">
                <label className="g3-label" htmlFor="wizard-custom-type">Précisez votre type d&apos;agent *</label>
                <input id="wizard-custom-type" className="g3-input" value={customType} onChange={(e) => setCustomType(e.target.value)} placeholder="Ex. Juridique, Immobilier, RH, Finance…" maxLength={80} />
                <p className="mt-1 text-xs text-neutral-400">Votre libellé devient le périmètre strict de l&apos;agent : il n&apos;interviendra que dans ce domaine.</p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-sky-800">Aperçu du périmètre</p>
            <p className="mt-1.5 text-sm leading-6 text-sky-900">
              {name.trim() || "Votre agent"} agira exclusivement comme{" "}
              <strong>{effectiveLabel || "spécialiste (type à préciser)"}</strong>
              {skills.length > 0 ? <> avec les compétences : {skills.join(", ")}</> : null}. Toute demande hors de ce domaine recevra un refus professionnel.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-2 border-t border-[rgba(23,23,20,0.09)] pt-5 sm:flex-row sm:justify-end">
        <button type="button" className="g3-btn g3-btn-ghost" onClick={onCancel}>Annuler</button>
        <button type="submit" className="g3-btn g3-btn-primary" disabled={!canSubmit || saving}>
          {saving ? <>Enregistrement<span className="g3-dots"><span /><span /><span /></span></> : editing ? "Enregistrer les modifications" : "Créer mon agent IA"}
        </button>
      </div>
    </form>
  );
}
