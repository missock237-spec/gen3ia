"use client";

import * as React from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { Field, Input, Textarea } from "@/components/ui/field";

/**
 * Onglet Évaluation de l'Agent Builder — Evals réels :
 * création de test sets (cas : demande → résultat attendu), exécution
 * facturée (réponse d'agent + juge LLM), historique et scores.
 */

interface EvalCase {
  id?: string;
  input: string;
  expected: string;
  criteria: string;
}

interface TestSet {
  id: string;
  name: string;
  description: string;
  cases: EvalCase[];
  createdAt: string;
}

interface RunSummary {
  runId: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  totalChargeMinor: number;
  durationMs: number;
  createdAt: string;
  error?: string;
}

interface RunResult {
  caseId: string;
  input: string;
  expected: string;
  output: string;
  score: number;
  passed: boolean;
  judgeFeedback: string;
}

interface TestRun {
  id: string;
  summary?: RunSummary;
}

const PASS_THRESHOLD = 0.7;

function scoreTone(score: number): "success" | "warning" | "danger" {
  if (score >= PASS_THRESHOLD) return "success";
  if (score >= 0.4) return "warning";
  return "danger";
}

export function AgentEvalsPanel({ agentId }: { agentId: string }) {
  const [sets, setSets] = React.useState<TestSet[]>([]);
  const [runsBySet, setRunsBySet] = React.useState<Record<string, TestRun[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState("");
  const [cases, setCases] = React.useState<Array<{ input: string; expected: string; criteria: string }>>([{ input: "", expected: "", criteria: "" }]);
  const [creating, setCreating] = React.useState(false);
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [lastRun, setLastRun] = React.useState<{ setId: string; summary: RunSummary; results: RunResult[] } | null>(null);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setError("");
    try {
      const response = await authFetch(`/api/agents/${agentId}/evals`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Chargement impossible.");
      setSets((data.sets ?? []) as TestSet[]);
      setRunsBySet((data.runs ?? {}) as Record<string, TestRun[]>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const createSet = async () => {
    const filled = cases.filter((entry) => entry.input.trim().length >= 2);
    if (!name.trim() || filled.length === 0) {
      setError("Nom du test set et au moins un cas avec une demande sont requis.");
      return;
    }
    setError("");
    setCreating(true);
    try {
      const response = await authFetch(`/api/agents/${agentId}/evals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), cases: filled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Création impossible.");
      setName("");
      setCases([{ input: "", expected: "", criteria: "" }]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible.");
    } finally {
      setCreating(false);
    }
  };

  const runSet = async (setId: string) => {
    setError("");
    setRunningId(setId);
    setLastRun(null);
    try {
      const response = await authFetch(`/api/agents/${agentId}/evals/${setId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Exécution impossible.");
      setLastRun({ setId, summary: data.summary as RunSummary, results: (data.summary?.results ?? []) as RunResult[] });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Exécution impossible.");
    } finally {
      setRunningId(null);
    }
  };

  const removeSet = async (setId: string) => {
    setError("");
    try {
      const response = await authFetch(`/api/agents/${agentId}/evals?setId=${encodeURIComponent(setId)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "Suppression impossible.");
      }
      setSets((current) => current.filter((set) => set.id !== setId));
      if (lastRun?.setId === setId) setLastRun(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible.");
    }
  };

  return (
    <div className="space-y-5">
      <div className="g3-card p-5 md:p-6">
        <h3 className="text-base font-bold">Créer un test set</h3>
        <p className="mt-1 text-sm leading-6" style={{ color: "var(--g3-muted)" }}>
          Chaque cas teste une demande réelle et le résultat attendu. L&apos;exécution interroge l&apos;agent (même charte que
          le chat), puis un juge note la conformité de 0 à 1. Chaque cas est facturé au tarif LLM standard.
        </p>
        <div className="mt-4 space-y-4">
          <Field label="Nom du test set" htmlFor="evals-name">
            <Input id="evals-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Questions clients fréquentes" maxLength={120} />
          </Field>
          {cases.map((entry, index) => (
            <div key={index} className="grid gap-3 rounded-2xl border p-4 md:grid-cols-3" style={{ borderColor: "var(--g3-border)" }}>
              <Field label={`Demande ${index + 1}`} htmlFor={`evals-input-${index}`}>
                <Textarea id={`evals-input-${index}`} className="!min-h-20" value={entry.input} maxLength={2000}
                  onChange={(event) => setCases((current) => current.map((item, i) => (i === index ? { ...item, input: event.target.value } : item)))}
                  placeholder="Question ou tâche envoyée à l'agent…" />
              </Field>
              <Field label="Résultat attendu" htmlFor={`evals-expected-${index}`}>
                <Textarea id={`evals-expected-${index}`} className="!min-h-20" value={entry.expected} maxLength={2000}
                  onChange={(event) => setCases((current) => current.map((item, i) => (i === index ? { ...item, expected: event.target.value } : item)))}
                  placeholder="Ce que l'agent doit répondre (points clés)…" />
              </Field>
              <Field label="Critères (optionnel)" htmlFor={`evals-criteria-${index}`}>
                <Textarea id={`evals-criteria-${index}`} className="!min-h-20" value={entry.criteria} maxLength={500}
                  onChange={(event) => setCases((current) => current.map((item, i) => (i === index ? { ...item, criteria: event.target.value } : item)))}
                  placeholder="Ex. cite les sources, ton professionnel…" />
              </Field>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="g3-btn g3-btn-ghost"
              onClick={() => setCases((current) => (current.length >= 20 ? current : [...current, { input: "", expected: "", criteria: "" }]))}
              disabled={cases.length >= 20}
            >
              + Ajouter un cas ({cases.length}/20)
            </button>
            <button type="button" className="g3-btn g3-btn-primary" onClick={() => void createSet()} disabled={creating}>
              {creating ? "Création…" : "Créer le test set"}
            </button>
          </div>
        </div>
      </div>

      {error && <Callout tone="error" className="rounded-2xl">{error}</Callout>}

      {loading ? (
        <p className="text-sm" style={{ color: "var(--g3-faint)" }}>Chargement des évaluations…</p>
      ) : sets.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Aucun test set"
          description="Créez votre premier test set pour mesurer la qualité de cet agent et détecter les régressions avant déploiement."
        />
      ) : (
        <div className="space-y-4">
          {sets.map((set) => {
            const history = runsBySet[set.id] ?? [];
            const lastSummary = lastRun?.setId === set.id ? lastRun.summary : history[0]?.summary;
            return (
              <div key={set.id} className="g3-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold">{set.name}</h4>
                    <p className="mt-0.5 text-xs" style={{ color: "var(--g3-muted)" }}>
                      {set.cases.length} cas · seuil de réussite {(PASS_THRESHOLD * 100).toFixed(0)} %
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {lastSummary && (
                      <Badge tone={scoreTone(lastSummary.avgScore)}>
                        Dernier score {(lastSummary.avgScore * 100).toFixed(0)} % · {lastSummary.passed}/{lastSummary.total}
                      </Badge>
                    )}
                    <button type="button" className="g3-btn g3-btn-primary !px-3 !py-1.5 text-xs" onClick={() => void runSet(set.id)} disabled={runningId !== null}>
                      {runningId === set.id ? "Exécution…" : "Lancer"}
                    </button>
                    <button type="button" className="g3-btn g3-btn-danger !px-3 !py-1.5 text-xs" onClick={() => void removeSet(set.id)}>Supprimer</button>
                  </div>
                </div>

                {runningId === set.id && (
                  <p className="mt-3 text-xs" style={{ color: "var(--g3-faint)" }}>
                    Exécution des cas + jugement en cours (30 s à quelques minutes selon le nombre de cas)…
                  </p>
                )}

                {lastRun?.setId === set.id && (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--g3-muted)" }}>Dernière exécution</p>
                    {lastRun.results.map((result, index) => (
                      <details key={result.caseId} className="rounded-xl border p-3" style={{ borderColor: "var(--g3-border)" }}>
                        <summary className="cursor-pointer text-xs font-semibold" style={{ color: "var(--g3-text)" }}>
                          Cas {index + 1} — {result.passed ? "Réussi" : "Échoué"} (score {(result.score * 100).toFixed(0)} %)
                        </summary>
                        <dl className="mt-2 space-y-1.5 text-xs leading-5" style={{ color: "var(--g3-muted)" }}>
                          <div><dt className="font-bold">Demande</dt><dd>{result.input}</dd></div>
                          <div><dt className="font-bold">Attendu</dt><dd>{result.expected || "—"}</dd></div>
                          <div><dt className="font-bold">Réponse de l&apos;agent</dt><dd className="whitespace-pre-wrap">{result.output || "—"}</dd></div>
                          <div><dt className="font-bold">Juge</dt><dd>{result.judgeFeedback}</dd></div>
                        </dl>
                      </details>
                    ))}
                  </div>
                )}

                {history.length > 0 && (
                  <p className="mt-3 text-[11px]" style={{ color: "var(--g3-faint)" }}>
                    Historique : {history.length} exécution(s) — dernière le {history[0].summary ? new Date(history[0].summary.createdAt).toLocaleString("fr-FR") : "—"}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
