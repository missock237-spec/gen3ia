"use client";

import * as React from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { AgentSummary } from "@/lib/agents/schema";

/**
 * Workflow Studio Gen3ia — éditeur fonctionnel de graphes exécutables.
 * Nœuds : agent, tool (risque maîtrisé), condition, transform, approval,
 * output, parallel. Chaque changement est enregistré explicitement ; le
 * bouton « Exécuter » lance le graphe réel (billed) et gère la reprise
 * après validation humaine (nœud approval).
 */

type NodeType = "agent" | "tool" | "condition" | "parallel" | "approval" | "transform" | "output";

interface WNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  enabled: boolean;
}
interface WEdge {
  id: string;
  source: string;
  target: string;
  condition?: string;
}
interface Workflow {
  id: string;
  name: string;
  version: number;
  nodes: WNode[];
  edges: WEdge[];
}

interface RunState {
  runId: string;
  status: string;
  result?: unknown;
  error?: string;
  approvalNodeId?: string;
  approvalId?: string;
  nodeStatuses: Record<string, string>;
}

const NODE_TYPES: Array<{ value: NodeType; label: string; hint: string }> = [
  { value: "agent", label: "Agent IA", hint: "Délègue la tâche à un agent du Studio (facturé)" },
  { value: "tool", label: "Outil", hint: "Outil Gen3ia à risque maîtrisé (web.search, knowledge.search…)" },
  { value: "condition", label: "Condition", hint: "Route le flux selon la sortie d'un nœud (true/false)" },
  { value: "transform", label: "Transformation", hint: "Assemble un texte à partir des sorties ({{nodeId}})" },
  { value: "approval", label: "Validation humaine", hint: "Met le workflow en pause jusqu'à votre validation" },
  { value: "output", label: "Résultat", hint: "Définit le résultat final du workflow" },
];

const EMPTY_CONFIG: Record<NodeType, Record<string, unknown>> = {
  agent: { agentId: "", task: "" },
  tool: { toolName: "web.search", input: { query: "" } },
  condition: { target: "", op: "existe", value: "" },
  parallel: {},
  approval: { message: "Valider pour continuer ?" },
  transform: { template: "Résumé : {{entree}}" },
  output: {},
};

let counter = 0;
const nextNodeId = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

function NodeConfigFields({
  type,
  config,
  agents,
  onChange,
}: {
  type: NodeType;
  config: Record<string, unknown>;
  agents: AgentSummary[];
  onChange: (config: Record<string, unknown>) => void;
}) {
  if (type === "agent") {
    return (
      <>
        <Field label="Agent à déléguer" htmlFor={`cfg-agent`}>
          <Select id="cfg-agent" value={String(config.agentId ?? "")} onChange={(e) => onChange({ ...config, agentId: e.target.value })}>
            <option value="">— choisir un agent —</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Tâche confiée ({{nodeId}} autorisés)" htmlFor={`cfg-task`}>
          <Textarea id="cfg-task" className="!min-h-16" value={String(config.task ?? "")} maxLength={2000}
            onChange={(e) => onChange({ ...config, task: e.target.value })}
            placeholder="Ex. Synthétise les résultats de {{recherche}} en 5 points…" />
        </Field>
      </>
    );
  }
  if (type === "tool") {
    return (
      <>
        <Field label="Outil Gen3ia" htmlFor={`cfg-tool`}>
          <Input id="cfg-tool" value={String(config.toolName ?? "")} maxLength={160}
            onChange={(e) => onChange({ ...config, toolName: e.target.value })}
            placeholder="web.search, knowledge.search…" />
        </Field>
        <Field label="Paramètre « query »" htmlFor={`cfg-input`}>
          <Input id="cfg-input" value={String((config.input as Record<string, unknown> | undefined)?.query ?? "")}
            onChange={(e) => onChange({ ...config, input: { ...(config.input as object ?? {}), query: e.target.value } })}
            placeholder="Requête (interpolations autorisées)" />
        </Field>
      </>
    );
  }
  if (type === "condition") {
    return (
      <>
        <Field label="Sortie à tester (id de nœud)" htmlFor={`cfg-target`}>
          <Input id="cfg-target" value={String(config.target ?? "")} maxLength={64}
            onChange={(e) => onChange({ ...config, target: e.target.value })} placeholder="Ex. recherche" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opération" htmlFor={`cfg-op`}>
            <Select id="cfg-op" value={String(config.op ?? "existe")} onChange={(e) => onChange({ ...config, op: e.target.value })}>
              <option value="existe">existe (non vide)</option>
              <option value="eq">égale à</option>
              <option value="contains">contient</option>
              <option value="gt">supérieur à</option>
              <option value="lt">inférieur à</option>
            </Select>
          </Field>
          <Field label="Valeur comparée" htmlFor={`cfg-value`}>
            <Input id="cfg-value" value={String(config.value ?? "")} maxLength={200}
              onChange={(e) => onChange({ ...config, value: e.target.value })} />
          </Field>
        </div>
      </>
    );
  }
  if (type === "transform" || type === "output") {
    return (
      <Field label="Gabarit du texte" htmlFor={`cfg-template`}>
        <Textarea id="cfg-template" className="!min-h-16" value={String(config.template ?? "")} maxLength={4000}
          onChange={(e) => onChange({ ...config, template: e.target.value })}
          placeholder="Ex. {{analyse}} — recommandations : {{plan}}" />
      </Field>
    );
  }
  if (type === "approval") {
    return (
      <Field label="Message de validation" htmlFor={`cfg-msg`}>
        <Input id="cfg-msg" value={String(config.message ?? "")} maxLength={500}
          onChange={(e) => onChange({ ...config, message: e.target.value })} />
      </Field>
    );
  }
  return <p className="text-xs" style={{ color: "var(--g3-faint)" }}>{NODE_TYPES.find((entry) => entry.value === type)?.hint}</p>;
}

export function WorkflowStudio() {
  const [workflows, setWorkflows] = React.useState<Workflow[]>([]);
  const [agents, setAgents] = React.useState<AgentSummary[]>([]);
  const [current, setCurrent] = React.useState<Workflow | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [run, setRun] = React.useState<RunState | null>(null);

  const load = React.useCallback(async () => {
    setError("");
    try {
      const [wfResponse, agentsResponse] = await Promise.all([
        authFetch("/api/workflows"),
        authFetch("/api/agents"),
      ]);
      const wfData = await wfResponse.json().catch(() => ({}));
      const agentsData = await agentsResponse.json().catch(() => ({}));
      if (wfResponse.ok) setWorkflows((wfData.workflows ?? []) as Workflow[]);
      if (agentsResponse.ok) setAgents((agentsData.agents ?? []) as AgentSummary[]);
    } catch {
      setError("Chargement des workflows impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const createWorkflow = async () => {
    setError("");
    setSaving(true);
    try {
      const entry: WNode = {
        id: nextNodeId(), type: "agent", name: "Étape 1", config: { agentId: agents[0]?.id ?? "", task: "" },
        position: { x: 80, y: 80 }, enabled: true,
      };
      const output: WNode = {
        id: nextNodeId(), type: "output", name: "Résultat", config: {}, position: { x: 80, y: 220 }, enabled: true,
      };
      const response = await authFetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Nouveau workflow",
          version: 1,
          nodes: [entry, output],
          edges: [{ id: nextNodeId(), source: entry.id, target: output.id }],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Création impossible.");
      await load();
      await open(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible.");
    } finally {
      setSaving(false);
    }
  };

  const open = async (id: string) => {
    setError("");
    setRun(null);
    const response = await authFetch(`/api/workflows/${id}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setError(data.error ?? "Ouverture impossible."); return; }
    setCurrent(data.workflow as Workflow);
  };

  const save = async () => {
    if (!current) return;
    setError("");
    setSaving(true);
    try {
      const response = await authFetch(`/api/workflows/${current.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: current.name, nodes: current.nodes, edges: current.edges }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Enregistrement impossible.");
      setNotice(`Enregistré (version ${data.version}).`);
      window.setTimeout(() => setNotice(""), 2500);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  };

  const execute = async (approve?: boolean) => {
    if (!current) return;
    setError("");
    setRunning(true);
    try {
      const response = await authFetch(`/api/workflows/${current.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(run?.runId && approve ? { runId: run.runId, approve: true } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Exécution impossible.");
      setRun(data.run as RunState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Exécution impossible.");
    } finally {
      setRunning(false);
    }
  };

  const updateCurrent = (mutate: (workflow: Workflow) => Workflow) => {
    setCurrent((existing) => (existing ? mutate(existing) : existing));
  };

  return (
    <div className="space-y-5">
      {error && <Callout tone="error" className="rounded-2xl">{error}</Callout>}
      {notice && <Callout tone="success" className="rounded-2xl">{notice}</Callout>}

      {!current ? (
        <div className="g3-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--g3-border)" }}>
            <h3 className="text-sm font-bold">Mes workflows</h3>
            <button type="button" className="g3-btn g3-btn-primary !px-3 !py-1.5 text-xs" onClick={() => void createWorkflow()} disabled={saving}>
              + Nouveau workflow
            </button>
          </div>
          {loading ? (
            <p className="px-5 py-8 text-center text-sm" style={{ color: "var(--g3-faint)" }}>Chargement…</p>
          ) : workflows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon="⎇"
                title="Aucun workflow"
                description="Créez un graphe d'automatisation : agents, outils, conditions et validations humaines — exécutable en un clic."
              />
            </div>
          ) : (
            <ul>
              {workflows.map((workflow) => (
                <li key={workflow.id} className="flex items-center justify-between gap-4 border-b px-5 py-3.5 last:border-b-0" style={{ borderColor: "var(--g3-border)" }}>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: "var(--g3-text)" }}>{workflow.name}</p>
                    <p className="text-xs" style={{ color: "var(--g3-muted)" }}>
                      v{workflow.version} · {workflow.nodes.length} nœuds · {workflow.edges.length} connexions
                    </p>
                  </div>
                  <button type="button" className="g3-btn g3-btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void open(workflow.id)}>
                    Ouvrir
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="g3-card p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field label="Nom du workflow" htmlFor="wf-name" className="min-w-0 flex-1">
                <Input id="wf-name" value={current.name} maxLength={120} onChange={(e) => updateCurrent((wf) => ({ ...wf, name: e.target.value }))} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="g3-btn g3-btn-ghost" onClick={() => void save()} disabled={saving}>
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </button>
                <button type="button" className="g3-btn g3-btn-primary" onClick={() => void execute()} disabled={running}>
                  {running ? "Exécution…" : "Exécuter"}
                </button>
                {run?.status === "awaiting_approval" && (
                  <button type="button" className="g3-btn g3-btn-success" onClick={() => void execute(true)} disabled={running}>
                    Valider et continuer
                  </button>
                )}
                <button type="button" className="g3-btn g3-btn-ghost" onClick={() => { setCurrent(null); setRun(null); }}>Fermer</button>
              </div>
            </div>
          </div>

          {run && (
            <div className="g3-card p-5">
              <div className="flex flex-wrap items-center gap-3">
                <h4 className="text-sm font-bold">Dernière exécution</h4>
                <Badge tone={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "warning"}>
                  {run.status === "completed" ? "Terminé" : run.status === "failed" ? "Échec" : run.status === "awaiting_approval" ? "En attente de validation" : run.status}
                </Badge>
              </div>
              {run.error && <p className="mt-2 text-xs" style={{ color: "var(--g3-danger-strong)" }}>{run.error}</p>}
              {run.status === "awaiting_approval" && (
                <p className="mt-2 text-xs" style={{ color: "var(--g3-warning-strong)" }}>
                  Le workflow est en pause sur un point de validation humaine. Vérifiez les résultats intermédiaires puis
                  cliquez sur « Valider et continuer ».
                </p>
              )}
              {run.result !== undefined && (
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl p-3 text-xs" style={{ background: "var(--g3-deep)", color: "var(--g3-text)" }}>
                  {typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2)}
                </pre>
              )}
            </div>
          )}

          <div className="g3-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-bold">Nœuds ({current.nodes.length})</h4>
              <div className="flex gap-2">
                {NODE_TYPES.slice(0, 3).map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    className="g3-btn g3-btn-ghost !px-2.5 !py-1.5 text-xs"
                    onClick={() =>
                      updateCurrent((wf) => ({
                        ...wf,
                        nodes: [...wf.nodes, {
                          id: nextNodeId(), type: type.value, name: type.label,
                          config: { ...EMPTY_CONFIG[type.value] }, position: { x: 80, y: 80 + wf.nodes.length * 40 }, enabled: true,
                        }],
                      }))
                    }
                  >
                    + {type.label}
                  </button>
                ))}
                <Select
                  aria-label="Ajouter un autre type de nœud"
                  className="!w-auto !py-1.5 text-xs"
                  value=""
                  onChange={(e) => {
                    const type = e.target.value as NodeType;
                    if (!type) return;
                    updateCurrent((wf) => ({
                      ...wf,
                      nodes: [...wf.nodes, {
                        id: nextNodeId(), type, name: NODE_TYPES.find((entry) => entry.value === type)?.label ?? type,
                        config: { ...EMPTY_CONFIG[type] }, position: { x: 80, y: 80 + wf.nodes.length * 40 }, enabled: true,
                      }],
                    }));
                  }}
                >
                  <option value="">+ Autre…</option>
                  {NODE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              {current.nodes.map((node, index) => (
                <div key={node.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--g3-border)" }}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge tone={node.type === "approval" ? "warning" : node.type === "output" ? "primary" : "neutral"}>
                      {index + 1} · {NODE_TYPES.find((entry) => entry.value === node.type)?.label ?? node.type}
                    </Badge>
                    {current.nodes.length > 2 && (
                      <button
                        type="button"
                        className="text-xs font-semibold"
                        style={{ color: "var(--g3-danger-strong)" }}
                        onClick={() => updateCurrent((wf) => ({
                          ...wf,
                          nodes: wf.nodes.filter((entry) => entry.id !== node.id),
                          edges: wf.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
                        }))}
                      >
                        Supprimer
                      </button>
                    )}
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <Field label="Nom du nœud" htmlFor={`node-name-${node.id}`}>
                      <Input id={`node-name-${node.id}`} value={node.name} maxLength={80}
                        onChange={(e) => updateCurrent((wf) => ({
                          ...wf,
                          nodes: wf.nodes.map((entry) => (entry.id === node.id ? { ...entry, name: e.target.value } : entry)),
                        }))} />
                    </Field>
                    <div className="md:col-span-2">
                      <NodeConfigFields
                        type={node.type}
                        config={node.config}
                        agents={agents}
                        onChange={(config) => updateCurrent((wf) => ({
                          ...wf,
                          nodes: wf.nodes.map((entry) => (entry.id === node.id ? { ...entry, config } : entry)),
                        }))}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="g3-card p-5">
            <h4 className="text-sm font-bold">Connexions ({current.edges.length})</h4>
            <p className="mt-1 text-xs" style={{ color: "var(--g3-muted)" }}>
              Enchaînez les nœuds. Depuis une condition, étiquetez les connexions « true » / « false » pour router le flux.
            </p>
            <div className="mt-3 space-y-2">
              {current.edges.map((edge) => (
                <div key={edge.id} className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="Nœud source"
                    className="!w-auto"
                    value={edge.source}
                    onChange={(e) => updateCurrent((wf) => ({
                      ...wf,
                      edges: wf.edges.map((entry) => (entry.id === edge.id ? { ...entry, source: e.target.value } : entry)),
                    }))}
                  >
                    {current.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                  </Select>
                  <span aria-hidden="true" style={{ color: "var(--g3-faint)" }}>→</span>
                  <Select
                    aria-label="Nœud cible"
                    className="!w-auto"
                    value={edge.target}
                    onChange={(e) => updateCurrent((wf) => ({
                      ...wf,
                      edges: wf.edges.map((entry) => (entry.id === edge.id ? { ...entry, target: e.target.value } : entry)),
                    }))}
                  >
                    {current.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                  </Select>
                  <Input
                    aria-label="Condition (true/false)"
                    className="!w-28"
                    placeholder="true/false"
                    value={edge.condition ?? ""}
                    maxLength={20}
                    onChange={(e) => updateCurrent((wf) => ({
                      ...wf,
                      edges: wf.edges.map((entry) => (entry.id === edge.id ? { ...entry, condition: e.target.value || undefined } : entry)),
                    }))}
                  />
                  <button
                    type="button"
                    className="text-xs font-semibold"
                    style={{ color: "var(--g3-danger-strong)" }}
                    onClick={() => updateCurrent((wf) => ({ ...wf, edges: wf.edges.filter((entry) => entry.id !== edge.id) }))}
                  >
                    Retirer
                  </button>
                </div>
              ))}
              {current.nodes.length >= 2 && (
                <button
                  type="button"
                  className="g3-btn g3-btn-ghost !px-3 !py-1.5 text-xs"
                  onClick={() => updateCurrent((wf) => ({
                    ...wf,
                    edges: [...wf.edges, { id: nextNodeId(), source: wf.nodes[0].id, target: wf.nodes[1].id }],
                  }))}
                >
                  + Ajouter une connexion
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
