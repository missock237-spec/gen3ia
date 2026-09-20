"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { VoiceAgentSetup } from "@/components/agent/voice-agent-setup";

/**
 * Gestionnaire d'agents personnalises : creation + personnalisation complete,
 * liste, execution immediate de missions, suppression.
 * Les agents de type "code" obtiennent un acces exclusif a l'Atelier d'Interfaces.
 */

type AgentType = "universal" | "code" | "content" | "research" | "automation";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  type: AgentType;
  status: string;
  projectId?: string;
  modelStrategy: "automatic" | "fixed";
  preferredProvider?: string;
  preferredModel?: string;
  autonomous: boolean;
  maxIterations: number;
  tools: string[];
  memoryEnabled: boolean;
  webResearchEnabled: boolean;
  documentGenerationEnabled: boolean;
  voiceEnabled: boolean;
  voiceConfig?: { language: string; greeting: string; maxTurns: number; maxDurationSeconds: number; inboundEnabled: boolean; outboundEnabled: boolean; };
  createdAt: string;
  updatedAt: string;
}

const TYPE_META: Record<AgentType, { label: string; description: string; icon: string; tone: string }> = {
  universal: { label: "Universel", description: "Polyvalent : raisonnement, recherche, documents.", icon: "M12 3v18M3 12h18", tone: "violet" },
  code: { label: "Agent de code", description: "Sandbox + Atelier d'Interfaces exclusif (21st.dev).", icon: "M8 6l-5 6 5 6M16 6l5 6-5 6", tone: "cyan" },
  content: { label: "Contenu", description: "Redaction, marketing, generation de documents.", icon: "M4 6h16M4 12h10M4 18h14", tone: "emerald" },
  research: { label: "Recherche", description: "Veille web, analyse de marche, synthese.", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35", tone: "amber" },
  automation: { label: "Automatisation", description: "Workflows repetitifs et orchestration d'outils.", icon: "M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M17 3v4h-4M7 21v-4h4", tone: "sky" },
};

const PROVIDERS = ["groq", "openrouter", "openai", "anthropic", "glm"] as const;

const TOOL_OPTIONS = [
  { id: "web.search", label: "Recherche web" },
  { id: "code.execute", label: "Execution de code" },
  { id: "artifact.create", label: "Creation de documents" },
  { id: "zip.create", label: "Archives ZIP" },
  { id: "memory.write", label: "Memoire permanente" },
  { id: "ui.components", label: "Composants 21st.dev (code)" },
  { id: "phone.call", label: "Appels téléphoniques IA" },
];

interface RunResult {
  executionId: string;
  status: string;
  outputs: Record<string, unknown>;
  billing?: { totalChargeMinor: number; currency: string };
  durationMs?: number;
  error?: string;
}

const toneClasses: Record<string, string> = {
  violet: "border-violet-200 bg-violet-100 text-violet-700",
  cyan: "border-sky-200 bg-sky-100 text-sky-700",
  emerald: "border-emerald-200 bg-emerald-100 text-emerald-600",
  amber: "border-amber-200 bg-amber-100 text-amber-700",
  sky: "border-sky-200 bg-sky-100 text-sky-700",
};

export function AgentManager() {
  const sessionDisponible = useSessionAvailable();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [voiceSetupAgentId, setVoiceSetupAgentId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [objectives, setObjectives] = useState<Record<string, string>>({});

  // Formulaire de creation
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<AgentType>("universal");
  const [agentMode, setAgentMode] = useState<"standard" | "voice">("standard");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelStrategy, setModelStrategy] = useState<"automatic" | "fixed">("automatic");
  const [provider, setProvider] = useState<string>("groq");
  const [preferredModel, setPreferredModel] = useState("");
  const [maxIterations, setMaxIterations] = useState(8);
  const [tools, setTools] = useState<string[]>(["web.search"]);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [webResearchEnabled, setWebResearchEnabled] = useState(true);
  const [documentGenerationEnabled, setDocumentGenerationEnabled] = useState(true);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState("");
  const [projectTools, setProjectTools] = useState<Array<{ id: string; name: string; toolkit: string; description?: string }>>([]);
  const [loadingProjectTools, setLoadingProjectTools] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [response, projectsResponse] = await Promise.all([
        authFetch(projectId ? `/api/agents?projectId=${encodeURIComponent(projectId)}` : "/api/agents", { cache: "no-store" }),
        authFetch("/api/developer/projects", { cache: "no-store" }),
      ]);
      if (response.ok) {
        const data = await response.json();
        setAgents(data.agents ?? []);
      }
      if (projectsResponse.ok) {
        const projectData = await projectsResponse.json();
        const nextProjects = (projectData.projects ?? []).filter((p: { status?: string }) => p.status !== "archived");
        setProjects(nextProjects);
        if (!projectId && nextProjects[0]?.id) setProjectId(nextProjects[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!projectId) {
      setProjectTools([]);
      return;
    }
    let cancelled = false;
    setLoadingProjectTools(true);
    void authFetch(`/api/developer/projects/${encodeURIComponent(projectId)}/connectors/sync`, { cache: "no-store" }).catch(() => undefined).then(() => authFetch(`/api/developer/projects/${encodeURIComponent(projectId)}/connectors/tools`, { cache: "no-store" }))
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) {
          const normalized = (data.tools ?? []).map((tool: Record<string, unknown>) => ({
            id: typeof tool.slug === "string" ? tool.slug : typeof tool.name === "string" ? tool.name : "",
            name: typeof tool.name === "string" ? tool.name : typeof tool.slug === "string" ? tool.slug : "Tool",
            toolkit: typeof tool.toolkit === "string" ? tool.toolkit : typeof tool.toolkit_slug === "string" ? tool.toolkit_slug : "composio",
            description: typeof tool.description === "string" ? tool.description : "",
          })).filter((tool: { id: string }) => tool.id);
          setProjectTools(normalized);
        }
      })
      .finally(() => { if (!cancelled) setLoadingProjectTools(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const hasCodeAgent = agents.some((agent) => agent.type === "code" && agent.status === "active");

  const toggleTool = (toolId: string) => {
    setTools((current) => (current.includes(toolId) ? current.filter((t) => t !== toolId) : [...current, toolId]));
  };

  const createAgent = async () => {
    if (sessionDisponible === false) {
      setError("Session expiree. Reconnectez-vous.");
      return;
    }
    setCreating(true);
    setError("");
    setMessage("");
    try {
      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          type,
          projectId: projectId || undefined,
          systemPrompt,
          modelStrategy,
          preferredProvider: modelStrategy === "fixed" ? provider : undefined,
          preferredModel: modelStrategy === "fixed" && preferredModel.trim() ? preferredModel.trim() : undefined,
          maxIterations,
          tools,
          memoryEnabled,
          webResearchEnabled,
          documentGenerationEnabled,
          status: "active",
          voiceEnabled: agentMode === "voice",
          voiceConfig: agentMode === "voice" ? { language: "fr-FR", greeting: "Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?", maxTurns: 20, maxDurationSeconds: 300, inboundEnabled: true, outboundEnabled: true, voiceEnabled: true } : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Creation impossible");
      setMessage(`Agent « ${data.agent.name} » cree et actif. Il peut desormais executer vos missions.`);
      setShowForm(false);
      if (agentMode === "voice") setVoiceSetupAgentId(data.agent.id);
      setName("");
      setDescription("");
      setSystemPrompt("");
      setAgentMode("standard");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Creation impossible");
    } finally {
      setCreating(false);
    }
  };

  const runAgent = async (agent: AgentSummary) => {
    const objective = (objectives[agent.id] ?? "").trim();
    if (objective.length < 3) {
      setError("Decrivez la mission de l'agent (au moins 3 caracteres).");
      return;
    }
    setError("");
    setRunningId(agent.id);
    setResults((current) => ({ ...current, [agent.id]: { executionId: "", status: "running", outputs: {} } }));
    try {
      const response = await authFetch(`/api/agents/${agent.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective, projectId: agent.projectId || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Execution impossible");
      setResults((current) => ({ ...current, [agent.id]: data }));
    } catch (e) {
      setResults((current) => ({
        ...current,
        [agent.id]: { executionId: "", status: "failed", outputs: {}, error: e instanceof Error ? e.message : "Execution impossible" },
      }));
    } finally {
      setRunningId(null);
    }
  };

  const deleteAgent = async (agent: AgentSummary) => {
    if (!window.confirm(`Supprimer definitivement l'agent « ${agent.name} » ?`)) return;
    const response = await authFetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (response.ok) {
      setAgents((current) => current.filter((a) => a.id !== agent.id));
      setMessage("Agent supprime.");
    } else {
      setError("Suppression impossible.");
    }
  };

  return (
    <div className="space-y-6">
      {/* En-tete : titre + actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold">Mes agents</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Creez un agent, personnalisez-le, puis lancez une mission : il s&apos;execute immediatement.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasCodeAgent && (
            <Link href="/studio/interface-lab" className="g3-btn g3-btn-cyan anim-scale-in">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6" /></svg>
              Atelier d&apos;Interfaces
            </Link>
          )}
          <button type="button" className="g3-btn g3-btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Fermer le formulaire" : "+ Nouvel agent"}
          </button>
        </div>
      </div>

      {message && (
        <div className="anim-fade-in rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div>
      )}
      {error && (
        <div className="anim-fade-in rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
      )}

      {/* Formulaire de creation / personnalisation */}
      {showForm && (
        <div className="g3-card anim-slide-up p-5 md:p-7">
          <h3 className="text-lg font-bold">Creer et personnaliser</h3>
          <p className="mt-1 text-sm text-neutral-500">Tout est modifiable plus tard. Un agent actif est immediatement executable.</p>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              <div>
                <label className="g3-label" htmlFor="agent-name">Nom de l&apos;agent</label>
                <input id="agent-name" className="g3-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Nexus, Analyste Pro…" maxLength={80} />
              </div>
              <div>
                <label className="g3-label" htmlFor="agent-desc">Description</label>
                <input id="agent-desc" className="g3-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A quoi sert cet agent ?" maxLength={500} />
              </div>
              <div>
                <span className="g3-label">Mode de création</span>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="g3-chip" data-selected={agentMode === "standard"} aria-pressed={agentMode === "standard"} onClick={() => setAgentMode("standard")}>
                    Standard
                  </button>
                  <button type="button" className="g3-chip" data-selected={agentMode === "voice"} aria-pressed={agentMode === "voice"} onClick={() => setAgentMode("voice")}>
                    Agent téléphonique (voix)
                  </button>
                </div>
                <p className="mt-1 text-xs text-neutral-400">En mode voix, l&apos;écran de configuration vocale s&apos;ouvre juste après la création.</p>
              </div>

              <div>
                <span className="g3-label">Type d&apos;agent</span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(Object.keys(TYPE_META) as AgentType[]).map((key) => {
                    const meta = TYPE_META[key];
                    const selected = type === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setType(key)}
                        aria-pressed={selected}
                        className={`rounded-xl border p-3 text-left transition-all duration-300 ${
                          selected ? "border-neutral-900 bg-neutral-50 shadow-[0_8px_24px_-12px_rgba(28,27,24,0.35)]" : "border-[rgba(23,23,20,0.09)] bg-white hover:border-neutral-300 hover:bg-neutral-50"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={selected ? "text-neutral-900" : "text-neutral-400"}>
                            <path d={meta.icon} />
                          </svg>
                          <span className="text-sm font-semibold">{meta.label}</span>
                          {key === "code" && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-sky-700">21st.dev</span>}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-neutral-500">{meta.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <div>
                <label className="g3-label" htmlFor="agent-prompt">Instructions systeme (personnalite, mission, style)</label>
                <textarea
                  id="agent-prompt"
                  className="g3-textarea min-h-36"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Ex. Tu es un analyste marketing senior. Tu structureras tes reponses en 3 parties…"
                  maxLength={20_000}
                />
                <p className="mt-1 text-xs text-neutral-400">{systemPrompt.length.toLocaleString("fr-FR")} / 20 000 caracteres</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="g3-label" htmlFor="agent-model-strategy">Modele</label>
                  <select id="agent-model-strategy" className="g3-select" value={modelStrategy} onChange={(e) => setModelStrategy(e.target.value as "automatic" | "fixed")}>
                    <option value="automatic">Automatique (recommande)</option>
                    <option value="fixed">Imposer un fournisseur</option>
                  </select>
                </div>
                <div>
                  <label className="g3-label" htmlFor="agent-iterations">Iterations max</label>
                  <input id="agent-iterations" type="number" min={1} max={20} className="g3-input" value={maxIterations} onChange={(e) => setMaxIterations(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
                </div>
              </div>
              {modelStrategy === "fixed" && (
                <div className="anim-fade-in grid grid-cols-2 gap-3">
                  <div>
                    <label className="g3-label" htmlFor="agent-provider">Fournisseur</label>
                    <select id="agent-provider" className="g3-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                      {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="g3-label" htmlFor="agent-model">Modele (optionnel)</label>
                    <input id="agent-model" className="g3-input" value={preferredModel} onChange={(e) => setPreferredModel(e.target.value)} placeholder="Ex. llama-3.3-70b" />
                  </div>
                </div>
              )}

              <div>
                <span className="g3-label">Projet Gen3ia</span>
                <select className="g3-select" value={projectId} onChange={(e) => { setProjectId(e.target.value); setTools((current) => current.filter((tool) => !tool.startsWith("composio:"))); }}>
                  <option value="">Aucun projet</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                <p className="mt-1 text-xs text-neutral-400">Les connecteurs Composio sont strictement isolés par projet.</p>
              </div>

              <div>
                <span className="g3-label">Outils autorises</span>
                <div className="flex flex-wrap gap-2">
                  {TOOL_OPTIONS.map((tool) => (
                    <button key={tool.id} type="button" className="g3-chip" data-selected={tools.includes(tool.id)} onClick={() => toggleTool(tool.id)} aria-pressed={tools.includes(tool.id)}>
                      {tool.label}
                    </button>
                  ))}
                </div>
                {projectId && (
                  <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-sky-800">Outils des connecteurs Composio</span>
                      <Link href="/developer" className="text-[11px] font-semibold text-sky-700 hover:underline">Gérer les connecteurs →</Link>
                    </div>
                    {loadingProjectTools ? <p className="mt-2 text-xs text-sky-700">Chargement des outils…</p> : projectTools.length === 0 ? (
                      <p className="mt-2 text-xs text-sky-700">Aucun outil disponible. Connectez d’abord une application dans le projet.</p>
                    ) : (
                      <div className="mt-2 max-h-48 space-y-1 overflow-auto">
                        {projectTools.map((tool) => {
                          const selection = `composio:${tool.toolkit}:${tool.id}`;
                          return <button key={selection} type="button" className="flex w-full items-start gap-2 rounded-lg border border-sky-100 bg-white px-2.5 py-2 text-left hover:bg-sky-50" onClick={() => toggleTool(selection)} aria-pressed={tools.includes(selection)}>
                            <span className={`mt-0.5 h-3 w-3 shrink-0 rounded border ${tools.includes(selection) ? "border-sky-600 bg-sky-600" : "border-sky-300"}`} />
                            <span className="min-w-0"><span className="block truncate text-xs font-medium text-neutral-800">{tool.name}</span><span className="block truncate text-[10px] text-neutral-500">{tool.toolkit}{tool.description ? ` · ${tool.description}` : ""}</span></span>
                          </button>;
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Toggle label="Memoire" checked={memoryEnabled} onChange={setMemoryEnabled} />
                <Toggle label="Recherche web" checked={webResearchEnabled} onChange={setWebResearchEnabled} />
                <Toggle label="Documents" checked={documentGenerationEnabled} onChange={setDocumentGenerationEnabled} />
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-2 border-t border-[rgba(23,23,20,0.09)] pt-5 sm:flex-row sm:justify-end">
            <button type="button" className="g3-btn g3-btn-ghost" onClick={() => setShowForm(false)}>Annuler</button>
            <button type="button" className="g3-btn g3-btn-primary" disabled={creating || name.trim().length < 2 || systemPrompt.trim().length < 10} onClick={createAgent}>
              {creating ? <>Creation<span className="g3-dots"><span /><span /><span /></span></> : "Creer l'agent"}
            </button>
          </div>
        </div>
      )}

      {voiceSetupAgentId && (
        <VoiceAgentSetup agentId={voiceSetupAgentId} onDone={async () => { setVoiceSetupAgentId(null); await refresh(); }} />
      )}

      {/* Liste des agents */}
      {loading ? (
        <div className="g3-card p-8 text-center text-sm text-neutral-500">
          Chargement de vos agents<span className="g3-dots"><span /><span /><span /></span>
        </div>
      ) : agents.length === 0 ? (
        <div className="g3-card p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-200 bg-violet-100 anim-float">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-violet-700"><path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16.8 5.6 21.2 8 14 2 9.2h7.6z" /></svg>
          </div>
          <h3 className="mt-4 font-bold">Aucun agent pour l&apos;instant</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">Creez votre premier agent : choisissez un type, ecrivez ses instructions, et lancez votre premiere mission en moins d&apos;une minute.</p>
          <button type="button" className="g3-btn g3-btn-primary mt-5" onClick={() => setShowForm(true)}>+ Creer mon premier agent</button>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {agents.map((agent, index) => {
            const meta = TYPE_META[agent.type] ?? TYPE_META.universal;
            const result = results[agent.id];
            return (
              <article key={agent.id} className="g3-card card-glow anim-fade-up p-5" style={{ animationDelay: `${index * 0.06}s` }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-bold">{agent.name}</h3>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${toneClasses[meta.tone]}`}>{meta.label}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${agent.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-600" : "border-[rgba(23,23,20,0.09)] bg-neutral-50 text-neutral-500"}`}>{agent.status}</span>
                    </div>
                    {agent.description && <p className="mt-1.5 line-clamp-2 text-sm text-neutral-600">{agent.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-neutral-500">
                      <span className="rounded border border-[rgba(23,23,20,0.09)] px-1.5 py-0.5">{agent.autonomous ? "Autonome" : "Guide"}</span>
                      <span className="rounded border border-[rgba(23,23,20,0.09)] px-1.5 py-0.5">{agent.maxIterations} iterations</span>
                      <span className="rounded border border-[rgba(23,23,20,0.09)] px-1.5 py-0.5">{agent.modelStrategy === "fixed" ? agent.preferredProvider ?? "modele fixe" : "modele auto"}</span>
                      {agent.tools.slice(0, 3).map((tool) => <span key={tool} className="rounded border border-[rgba(23,23,20,0.09)] px-1.5 py-0.5">{tool}</span>)}
                    </div>
                  </div>
                  <button type="button" className="g3-btn g3-btn-danger !px-3 !py-2 text-xs" onClick={() => deleteAgent(agent)} aria-label={`Supprimer ${agent.name}`}>
                    Supprimer
                  </button>
                </div>

                {agent.type === "code" && agent.status === "active" && (
                  <Link href="/studio/interface-lab" className="mt-4 flex items-center justify-between rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700 transition-colors hover:bg-sky-100">
                    <span className="flex items-center gap-2">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6" /></svg>
                      Atelier d&apos;Interfaces — exclusivite agent de code
                    </span>
                    <span aria-hidden="true">→</span>
                  </Link>
                )}

                {agent.voiceEnabled && <button type="button" className="mt-3 w-full rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-left text-sm text-sky-700 hover:bg-sky-100" onClick={() => setVoiceSetupAgentId(agent.id)}>Configurer le numéro et la voix</button>}

                <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><p className="text-xs font-bold uppercase tracking-wide text-violet-700">Lien client</p><p className="mt-1 text-xs text-violet-900">Partagez ce lien dans vos publicités pour ouvrir le chat.</p></div>
                    <button type="button" className="g3-btn g3-btn-ghost !px-3 !py-2 text-xs" onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/client/${agent.id}`)}>Copier le lien</button>
                  </div>
                  <p className="mt-2 truncate rounded-lg bg-white/70 px-2 py-1 text-xs text-violet-800">{typeof window !== "undefined" ? `${window.location.origin}/client/${agent.id}` : `/client/${agent.id}`}</p>
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <input
                    className="g3-input flex-1"
                    value={objectives[agent.id] ?? ""}
                    onChange={(e) => setObjectives((current) => ({ ...current, [agent.id]: e.target.value }))}
                    placeholder={`Mission pour ${agent.name}…`}
                    maxLength={20_000}
                  />
                  <button type="button" className="g3-btn g3-btn-primary" disabled={runningId === agent.id || (objectives[agent.id] ?? "").trim().length < 3} onClick={() => runAgent(agent)}>
                    {runningId === agent.id ? <>Execution<span className="g3-dots"><span /><span /><span /></span></> : "Executer"}
                  </button>
                </div>

                {result && (
                  <div className="anim-slide-up mt-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4">
                    {result.status === "running" && <div className="g3-progress" aria-label="Execution en cours" />}
                    {result.error && <p className="text-sm text-red-600">{result.error}</p>}
                    {result.status !== "running" && !result.error && (
                      <>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                          <span className={`rounded-full border px-2 py-0.5 font-semibold uppercase ${result.status === "completed" ? "border-emerald-200 bg-emerald-50 text-emerald-600" : "border-red-200 bg-red-50 text-red-600"}`}>{result.status}</span>
                          {typeof result.durationMs === "number" && <span>{(result.durationMs / 1000).toFixed(1)} s</span>}
                          {result.billing && <span>{(result.billing.totalChargeMinor / 100).toFixed(4)} {result.billing.currency}</span>}
                          <span className="truncate">#{result.executionId.slice(0, 8)}</span>
                        </div>
                        <div className="mt-2 space-y-2">
                          {Object.entries(result.outputs).map(([stepId, output]) => (
                            <div key={stepId}>
                              <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">{stepId}</div>
                              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-neutral-800">
                                {typeof output === "string" ? output.slice(0, 2400) : JSON.stringify(output, null, 2).slice(0, 2400)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-3 py-2.5 text-sm transition-colors hover:bg-neutral-50">
      <span className="text-neutral-700">{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} data-on={checked} className="g3-switch" onClick={() => onChange(!checked)} />
    </label>
  );
}
