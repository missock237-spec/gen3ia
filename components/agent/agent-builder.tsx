"use client";

import * as React from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
import { Tabs } from "@/components/ui/tabs";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import type { AgentSummary } from "@/lib/agents/schema";
import { AgentEvalsPanel } from "./agent-evals-panel";
import { AgentWizard } from "./agent-wizard";

/**
 * Agent Builder Gen3ia — édition à onglets d'un agent IA.
 *
 * - Création : l'onglet GÉNÉRAL (wizard complet) crée l'agent ; les autres
 *   onglets s'activent après création.
 * - Édition : tous les onglets sont disponibles, chaque section enregistre
 *   réellement via PATCH /api/agents/[id] (aucun réglage décoratif).
 */

type BuilderTab = "general" | "model" | "tools" | "subagents" | "permissions" | "evals" | "deployment";

const TAB_ITEMS: Array<{ id: BuilderTab; label: string }> = [
  { id: "general", label: "Général" },
  { id: "model", label: "Modèle" },
  { id: "tools", label: "Outils & MCP" },
  { id: "subagents", label: "Sous-agents" },
  { id: "permissions", label: "Permissions" },
  { id: "evals", label: "Évaluation" },
  { id: "deployment", label: "Déploiement" },
];

const PROVIDERS = [
  { value: "", label: "Automatique (routage Gen3ia)" },
  { value: "groq", label: "Groq" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "glm", label: "GLM" },
  { value: "huggingface", label: "HuggingFace" },
];

const AUTH_MODES: Array<{ value: "always_ask" | "ask_if_needed" | "auto_allow"; label: string; detail: string }> = [
  {
    value: "always_ask",
    label: "Toujours demander",
    detail: "Toute action sensible (outils externes, fichiers, publications, appels) attend votre confirmation explicite.",
  },
  {
    value: "ask_if_needed",
    label: "Demander si nécessaire",
    detail: "Les actions non critiques sont exécutées automatiquement ; les actions critiques (suppression de fichiers, publication publicitaire, appels téléphoniques) restent toujours soumises à validation.",
  },
  {
    value: "auto_allow",
    label: "Autoriser automatiquement",
    detail: "Les actions non critiques s'exécutent sans confirmation. Le plancher de sécurité Gen3ia reste invariable : les actions critiques exigent TOUJOURS votre approbation.",
  },
];

interface BuilderSectionProps {
  agent: AgentSummary;
  onSaved: (agent: AgentSummary) => void;
}

function useSectionSaver(agent: AgentSummary, onSaved: (agent: AgentSummary) => void) {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  const save = React.useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      setError("");
      setSaved(false);
      try {
        const response = await authFetch(`/api/agents/${agent.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Enregistrement impossible.");
        onSaved(data.agent as AgentSummary);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2500);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Enregistrement impossible.");
      } finally {
        setSaving(false);
      }
    },
    [agent.id, onSaved],
  );

  return { save, saving, error, saved };
}

function SectionFooter({ saving, saved, error, dirty }: { saving: boolean; saved: boolean; error: string; dirty: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" className="g3-btn g3-btn-primary" disabled={saving || !dirty}>
        {saving ? "Enregistrement…" : "Enregistrer"}
      </button>
      {saved && !error && <Badge tone="success">Enregistré</Badge>}
      {error && <span className="text-xs font-semibold" style={{ color: "var(--g3-danger-strong)" }}>{error}</span>}
    </div>
  );
}

function ModelSection({ agent, onSaved }: BuilderSectionProps) {
  const [modelStrategy, setModelStrategy] = React.useState<"automatic" | "fixed">(agent.modelStrategy ?? "automatic");
  const [provider, setProvider] = React.useState(agent.preferredProvider ?? "");
  const [model, setModel] = React.useState(agent.preferredModel ?? "");
  const [temperature, setTemperature] = React.useState<number>(agent.temperature ?? 0.7);
  const { save, saving, error, saved } = useSectionSaver(agent, onSaved);

  const dirty =
    modelStrategy !== (agent.modelStrategy ?? "automatic") ||
    provider !== (agent.preferredProvider ?? "") ||
    model !== (agent.preferredModel ?? "") ||
    temperature !== (agent.temperature ?? 0.7);

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          modelStrategy,
          preferredProvider: modelStrategy === "fixed" && provider ? provider : undefined,
          preferredModel: modelStrategy === "fixed" && model.trim() ? model.trim() : undefined,
          temperature,
        });
      }}
    >
      <Field label="Stratégie de modèle" htmlFor="builder-model-strategy">
        <Select id="builder-model-strategy" value={modelStrategy} onChange={(e) => setModelStrategy(e.target.value as "automatic" | "fixed")}>
          <option value="automatic">Automatique — Gen3ia route vers le meilleur modèle selon la tâche</option>
          <option value="fixed">Fixe — forcer un fournisseur et un modèle</option>
        </Select>
      </Field>

      {modelStrategy === "fixed" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fournisseur" htmlFor="builder-provider">
            <Select id="builder-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value} disabled={p.value === ""}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Modèle" htmlFor="builder-model" hint="Ex. llama-3.3-70b-versatile, claude-sonnet-4-5…">
            <Input id="builder-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Identifiant exact du modèle" maxLength={160} />
          </Field>
        </div>
      )}

      <Field
        label={`Température : ${temperature.toFixed(1)}`}
        htmlFor="builder-temperature"
        hint="0 = strictement déterministe (analyse, code) · 0,7 = équilibré · 1+ = créatif (rédaction, idées)"
      >
        <input
          id="builder-temperature"
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          className="w-full accent-[var(--g3-primary)]"
        />
      </Field>

      <SectionFooter saving={saving} saved={saved} error={error} dirty={dirty} />
    </form>
  );
}

function ToolsSection({ agent, onSaved }: BuilderSectionProps) {
  const [memoryEnabled, setMemoryEnabled] = React.useState(agent.memoryEnabled ?? true);
  const [webResearchEnabled, setWebResearchEnabled] = React.useState(agent.webResearchEnabled ?? true);
  const [documentGenerationEnabled, setDocumentGenerationEnabled] = React.useState(agent.documentGenerationEnabled ?? true);
  const [mcpEnabled, setMcpEnabled] = React.useState(agent.mcpEnabled ?? true);
  const { save, saving, error, saved } = useSectionSaver(agent, onSaved);

  const dirty =
    memoryEnabled !== (agent.memoryEnabled ?? true) ||
    webResearchEnabled !== (agent.webResearchEnabled ?? true) ||
    documentGenerationEnabled !== (agent.documentGenerationEnabled ?? true) ||
    mcpEnabled !== (agent.mcpEnabled ?? true);

  const toggles: Array<{ key: string; label: string; detail: string; value: boolean; set: (v: boolean) => void }> = [
    { key: "web", label: "Recherche web", detail: "L'agent peut interroger le web pour vérifier et enrichir ses réponses.", value: webResearchEnabled, set: setWebResearchEnabled },
    { key: "docs", label: "Génération de documents", detail: "L'agent peut produire des livrables téléchargeables (PDF, Excel, PowerPoint…).", value: documentGenerationEnabled, set: setDocumentGenerationEnabled },
    { key: "memory", label: "Mémoire permanente", detail: "L'agent peut mémoriser et retrouver des informations entre les sessions.", value: memoryEnabled, set: setMemoryEnabled },
    { key: "mcp", label: "Serveurs MCP", detail: "L'agent peut utiliser les serveurs MCP que vous avez connectés (outils externes).", value: mcpEnabled, set: setMcpEnabled },
  ];

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ memoryEnabled, webResearchEnabled, documentGenerationEnabled, mcpEnabled });
      }}
    >
      <div className="space-y-3">
        {toggles.map((toggle) => (
          <label
            key={toggle.key}
            className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border p-4 transition-colors"
            style={{ borderColor: "var(--g3-border)", background: "var(--g3-surface)" }}
          >
            <span className="min-w-0">
              <span className="block text-sm font-bold" style={{ color: "var(--g3-text)" }}>{toggle.label}</span>
              <span className="mt-0.5 block text-xs leading-5" style={{ color: "var(--g3-muted)" }}>{toggle.detail}</span>
            </span>
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[var(--g3-primary)]" checked={toggle.value} onChange={(e) => toggle.set(e.target.checked)} />
          </label>
        ))}
      </div>

      <div>
        <p className="g3-label">Outils déclarés du type d&apos;agent</p>
        <div className="flex flex-wrap gap-1.5">
          {(agent.tools ?? []).map((tool) => (
            <Badge key={tool} tone="neutral">{tool}</Badge>
          ))}
          {(agent.tools ?? []).length === 0 && <span className="text-xs" style={{ color: "var(--g3-faint)" }}>Aucun outil déclaré.</span>}
        </div>
        <p className="mt-2 text-[11px] leading-4" style={{ color: "var(--g3-faint)" }}>
          Ce périmètre est défini par le type d&apos;agent (Général). Les bascules ci-dessus activent ou désactivent des familles entières de capacités.
        </p>
      </div>

      <SectionFooter saving={saving} saved={saved} error={error} dirty={dirty} />
    </form>
  );
}

function SubAgentsSection({ agent, onSaved }: BuilderSectionProps) {
  const [allAgents, setAllAgents] = React.useState<AgentSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<string[]>(agent.subAgentIds ?? []);
  const { save, saving, error, saved } = useSectionSaver(agent, onSaved);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authFetch("/api/agents");
        const data = await response.json().catch(() => ({}));
        if (!cancelled && response.ok) setAllAgents((data.agents ?? []) as AgentSummary[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = allAgents.filter((entry) => entry.id !== agent.id);
  const dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...(agent.subAgentIds ?? [])].sort());

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= 5 ? current : [...current, id],
    );
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ subAgentIds: selected });
      }}
    >
      <p className="text-sm leading-6" style={{ color: "var(--g3-muted)" }}>
        Sélectionnez jusqu&apos;à 5 agents que <strong style={{ color: "var(--g3-text)" }}>{agent.name}</strong> pourra consulter
        pour des sous-tâches spécialisées. Lors d&apos;une mission, le planificateur peut déléguer une étape à l&apos;un d&apos;eux :
        la réponse est produite avec ses propres instructions et son propre modèle, puis intégrée au résultat final.
      </p>

      {loading ? (
        <p className="text-sm" style={{ color: "var(--g3-faint)" }}>Chargement de vos agents…</p>
      ) : candidates.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--g3-faint)" }}>
          Vous n&apos;avez pas encore d&apos;autres agents. Créez d&apos;abord des agents spécialisés (recherche, code, rédaction…)
          puis revenez les rattacher ici.
        </p>
      ) : (
        <div className="space-y-2">
          {candidates.map((entry) => {
            const isSelected = selected.includes(entry.id);
            return (
              <label
                key={entry.id}
                className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border p-3.5 transition-colors"
                style={{
                  borderColor: isSelected ? "var(--g3-primary)" : "var(--g3-border)",
                  background: isSelected ? "var(--g3-primary-soft)" : "var(--g3-surface)",
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold" style={{ color: "var(--g3-text)" }}>{entry.name}</span>
                  <span className="mt-0.5 block truncate text-xs" style={{ color: "var(--g3-muted)" }}>
                    {entry.typeLabel || entry.type} — {entry.description || "Sans description"}
                  </span>
                </span>
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--g3-primary)]" checked={isSelected} onChange={() => toggle(entry.id)} />
              </label>
            );
          })}
        </div>
      )}

      <SectionFooter saving={saving} saved={saved} error={error} dirty={dirty} />
    </form>
  );
}

function PermissionsSection({ agent, onSaved }: BuilderSectionProps) {
  const [authorizationMode, setAuthorizationMode] = React.useState<"always_ask" | "ask_if_needed" | "auto_allow">(agent.authorizationMode ?? "always_ask");
  const { save, saving, error, saved } = useSectionSaver(agent, onSaved);

  const dirty = authorizationMode !== (agent.authorizationMode ?? "always_ask");

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ authorizationMode });
      }}
    >
      <p className="text-sm leading-6" style={{ color: "var(--g3-muted)" }}>
        Ce réglage définit le comportement <strong style={{ color: "var(--g3-text)" }}>par défaut</strong> de l&apos;agent face aux
        actions sensibles. Le sélecteur du composer (« Toujours demander ▼ ») reste prioritaire pendant une conversation.
      </p>
      <div className="space-y-3" role="radiogroup" aria-label="Mode d'autorisation par défaut">
        {AUTH_MODES.map((mode) => {
          const isSelected = authorizationMode === mode.value;
          return (
            <label
              key={mode.value}
              className="flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors"
              style={{
                borderColor: isSelected ? "var(--g3-primary)" : "var(--g3-border)",
                background: isSelected ? "var(--g3-primary-soft)" : "var(--g3-surface)",
              }}
            >
              <input
                type="radio"
                name="builder-authorization-mode"
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--g3-primary)]"
                checked={isSelected}
                onChange={() => setAuthorizationMode(mode.value)}
              />
              <span>
                <span className="block text-sm font-bold" style={{ color: "var(--g3-text)" }}>{mode.label}</span>
                <span className="mt-0.5 block text-xs leading-5" style={{ color: "var(--g3-muted)" }}>{mode.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      <SectionFooter saving={saving} saved={saved} error={error} dirty={dirty} />
    </form>
  );
}

function DeploymentSection({ agent, onSaved }: BuilderSectionProps) {
  const [status, setStatus] = React.useState<"active" | "paused">(agent.status === "paused" ? "paused" : "active");
  const [autonomous, setAutonomous] = React.useState(agent.autonomous ?? true);
  const [maxIterations, setMaxIterations] = React.useState(agent.maxIterations ?? 8);
  const [budgetEuros, setBudgetEuros] = React.useState<string>(
    typeof agent.budgetEurMinor === "number" && agent.budgetEurMinor > 0 ? (agent.budgetEurMinor / 100).toFixed(2) : "",
  );
  const { save, saving, error, saved } = useSectionSaver(agent, onSaved);

  const budgetMinor = budgetEuros.trim() === "" ? 0 : Math.round(Number(budgetEuros.replace(",", ".")) * 100);
  const budgetValid = budgetEuros.trim() === "" || (Number.isFinite(budgetMinor) && budgetMinor >= 0);

  const dirty =
    status !== (agent.status === "paused" ? "paused" : "active") ||
    autonomous !== (agent.autonomous ?? true) ||
    maxIterations !== (agent.maxIterations ?? 8) ||
    budgetMinor !== (agent.budgetEurMinor ?? 0);

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!budgetValid) return;
        void save({
          status,
          autonomous,
          maxIterations,
          budgetEurMinor: budgetMinor > 0 ? budgetMinor : 0,
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Statut de l'agent" htmlFor="builder-status">
          <Select id="builder-status" value={status} onChange={(e) => setStatus(e.target.value as "active" | "paused")}>
            <option value="active">Actif — utilisable dans le chat et via API</option>
            <option value="paused">En pause — aucune exécution possible</option>
          </Select>
        </Field>
        <Field label="Itérations maximales par mission" htmlFor="builder-iterations" hint="Nombre d'étapes autonomes avant arrêt de sécurité.">
          <Input
            id="builder-iterations"
            type="number"
            min={1}
            max={20}
            value={maxIterations}
            onChange={(e) => setMaxIterations(Math.max(1, Math.min(20, Number(e.target.value) || 8)))}
          />
        </Field>
      </div>

      <Field
        label="Plafond de dépense par exécution (EUR)"
        htmlFor="builder-budget"
        hint="Laissez vide pour ne pas plafonner. Au-delà du montant, l'exécution est interrompue avec une erreur explicite."
        error={budgetValid ? undefined : "Montant invalide."}
      >
        <Input
          id="builder-budget"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={budgetEuros}
          onChange={(e) => setBudgetEuros(e.target.value)}
          placeholder="Ex. 2.00"
        />
      </Field>

      <label
        className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border p-4"
        style={{ borderColor: "var(--g3-border)", background: "var(--g3-surface)" }}
      >
        <span>
          <span className="block text-sm font-bold" style={{ color: "var(--g3-text)" }}>Mode autonome</span>
          <span className="mt-0.5 block text-xs leading-5" style={{ color: "var(--g3-muted)" }}>
            Autorise l&apos;exécution multi-étapes des missions (plans, outils, livrables). Désactivé, l&apos;agent répond uniquement en conversation.
          </span>
        </span>
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[var(--g3-primary)]" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
      </label>

      <SectionFooter saving={saving} saved={saved} error={error} dirty={dirty} />
    </form>
  );
}

export interface AgentBuilderProps {
  /** Agent à modifier, ou null en création. */
  editing?: AgentSummary | null;
  onSaved: (agent: AgentSummary) => void;
  onCancel: () => void;
}

/**
 * Assistant de création par langage naturel : l'utilisateur décrit son
 * besoin, l'IA propose une configuration structurée réelle, l'utilisateur
 * crée l'agent en un clic (puis l'ajuste dans les onglets du Builder).
 */
function NaturalLanguageCreator({ onCreated, onCancel }: { onCreated: (agent: AgentSummary) => void; onCancel: () => void }) {
  const [description, setDescription] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState("");
  const [proposal, setProposal] = React.useState<Record<string, unknown> | null>(null);

  const generate = async () => {
    setError("");
    setProposal(null);
    setGenerating(true);
    try {
      const response = await authFetch("/api/agents/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: description.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "La génération a échoué.");
      setProposal(data.proposal as Record<string, unknown>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "La génération a échoué.");
    } finally {
      setGenerating(false);
    }
  };

  const create = async () => {
    if (!proposal) return;
    setError("");
    setCreating(true);
    try {
      const persona = (proposal.persona ?? {}) as Record<string, unknown>;
      const capabilities = {
        webSearch: proposal.webResearchEnabled !== false,
        codeExecution: proposal.codeExecutionEnabled === true,
        dataAnalysis: true,
        fileGeneration: proposal.documentGenerationEnabled !== false,
      };
      const payload = {
        name: proposal.name,
        description: proposal.description,
        type: proposal.type,
        typeLabel: proposal.typeLabel,
        skills: proposal.skills,
        systemPrompt: proposal.systemPrompt,
        persona: { ...persona, capabilities },
        modelStrategy: proposal.modelStrategy ?? "automatic",
        preferredProvider: proposal.preferredProvider,
        preferredModel: proposal.preferredModel,
        temperature: proposal.temperature,
        tools: proposal.tools,
        webResearchEnabled: proposal.webResearchEnabled !== false,
        documentGenerationEnabled: proposal.documentGenerationEnabled !== false,
        authorizationMode: proposal.authorizationMode ?? "always_ask",
        status: "active",
      };
      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Création impossible.");
      onCreated(data.agent as AgentSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible.");
    } finally {
      setCreating(false);
    }
  };

  const typedProposal = proposal as
    | { name?: string; description?: string; type?: string; typeLabel?: string; skills?: string[]; temperature?: number; reasoning?: string; tools?: string[] }
    | null;

  return (
    <div className="space-y-4">
      <div className="g3-card p-5 md:p-6">
        <h2 className="text-lg font-bold md:text-xl">Décrivez l&apos;agent que vous voulez</h2>
        <p className="mt-1 text-sm leading-6" style={{ color: "var(--g3-muted)" }}>
          Exemple : « Je veux un agent développeur capable de travailler sur mon dépôt GitHub : il analyse le code,
          propose des correctifs et documente les changements. » Gen3ia propose une configuration complète que vous
          pourrez affiner dans le Builder.
        </p>
        <Textarea
          className="mt-4 min-h-28"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
          placeholder="Décrivez la mission, les outils et le style de votre agent…"
          aria-label="Description de l'agent souhaité"
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="g3-btn g3-btn-primary" onClick={() => void generate()} disabled={generating || description.trim().length < 15}>
            {generating ? "Génération de la configuration…" : "Générer la configuration"}
          </button>
          <button type="button" className="g3-btn g3-btn-ghost" onClick={onCancel}>Annuler</button>
          {description.trim().length > 0 && description.trim().length < 15 && (
            <span className="text-xs" style={{ color: "var(--g3-faint)" }}>Encore {15 - description.trim().length} caractères…</span>
          )}
        </div>
      </div>

      {error && <Callout tone="error" className="rounded-2xl">{error}</Callout>}

      {typedProposal && (
        <div className="g3-card anim-slide-up p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold">Voici la configuration que je propose</h3>
              <p className="mt-0.5 text-xs" style={{ color: "var(--g3-faint)" }}>{typedProposal.reasoning}</p>
            </div>
            <Badge tone="primary">{typedProposal.typeLabel || typedProposal.type}</Badge>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex gap-2"><dt className="w-28 shrink-0 font-semibold" style={{ color: "var(--g3-muted)" }}>Nom</dt><dd className="min-w-0 font-bold">{typedProposal.name}</dd></div>
            <div className="flex gap-2"><dt className="w-28 shrink-0 font-semibold" style={{ color: "var(--g3-muted)" }}>Mission</dt><dd className="min-w-0">{typedProposal.description}</dd></div>
            <div className="flex gap-2"><dt className="w-28 shrink-0 font-semibold" style={{ color: "var(--g3-muted)" }}>Compétences</dt><dd className="min-w-0 flex flex-wrap gap-1">{(typedProposal.skills ?? []).map((skill) => <Badge key={skill} tone="neutral">{skill}</Badge>)}</dd></div>
            <div className="flex gap-2"><dt className="w-28 shrink-0 font-semibold" style={{ color: "var(--g3-muted)" }}>Outils</dt><dd className="min-w-0 flex flex-wrap gap-1">{(typedProposal.tools ?? []).map((tool) => <Badge key={tool} tone="info">{tool}</Badge>)}</dd></div>
            <div className="flex gap-2"><dt className="w-28 shrink-0 font-semibold" style={{ color: "var(--g3-muted)" }}>Température</dt><dd>{typeof typedProposal.temperature === "number" ? typedProposal.temperature.toFixed(1) : "0.7"}</dd></div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" className="g3-btn g3-btn-primary" onClick={() => void create()} disabled={creating}>
              {creating ? "Création…" : "Créer cet agent"}
            </button>
            <button type="button" className="g3-btn g3-btn-ghost" onClick={() => setProposal(null)}>Modifier à la main</button>
          </div>
        </div>
      )}

      <AgentWizard editing={null} onSaved={onCreated} onCancel={onCancel} />
    </div>
  );
}

export function AgentBuilder({ editing = null, onSaved, onCancel }: AgentBuilderProps) {
  const [activeTab, setActiveTab] = React.useState<BuilderTab>("general");
  const [current, setCurrent] = React.useState<AgentSummary | null>(editing);

  // Création : seul l'onglet Général est actif ; après POST, l'agent passe
  // en mode édition et tous les onglets s'ouvrent.
  const isCreate = current === null;

  const handleWizardSaved = (agent: AgentSummary) => {
    setCurrent(agent);
    onSaved(agent);
    setActiveTab("model");
  };

  const handleSectionSaved = (agent: AgentSummary) => {
    setCurrent(agent);
    onSaved(agent);
  };

  if (isCreate) {
    return (
      <NaturalLanguageCreator onCreated={handleWizardSaved} onCancel={onCancel} />
    );
  }

  const agent = current as AgentSummary;

  return (
    <div className="g3-card anim-slide-up p-4 md:p-6" aria-label="Agent Builder">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold md:text-xl">{agent.name}</h2>
          <p className="mt-0.5 line-clamp-2 text-sm leading-5" style={{ color: "var(--g3-muted)" }}>
            {agent.description || "Agent Gen3ia"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={agent.status === "active" ? "success" : agent.status === "paused" ? "warning" : "neutral"}>
            {agent.status === "active" ? "Actif" : agent.status === "paused" ? "En pause" : agent.status}
          </Badge>
          <button type="button" className="g3-btn g3-btn-ghost !px-3 !py-1.5 text-xs" onClick={onCancel}>
            Fermer
          </button>
        </div>
      </div>

      <div className="mt-4">
        <Tabs items={TAB_ITEMS} active={activeTab} onChange={setActiveTab} ariaLabel="Sections du Builder" />
      </div>

      <div className="mt-5">
        {activeTab === "general" && <AgentWizard editing={agent} onSaved={handleSectionSaved} onCancel={onCancel} />}
        {activeTab === "model" && <ModelSection agent={agent} onSaved={handleSectionSaved} />}
        {activeTab === "tools" && <ToolsSection agent={agent} onSaved={handleSectionSaved} />}
        {activeTab === "subagents" && <SubAgentsSection agent={agent} onSaved={handleSectionSaved} />}
        {activeTab === "permissions" && <PermissionsSection agent={agent} onSaved={handleSectionSaved} />}
        {activeTab === "evals" && <AgentEvalsPanel agentId={agent.id} />}
        {activeTab === "deployment" && <DeploymentSection agent={agent} onSaved={handleSectionSaved} />}
      </div>
    </div>
  );
}
