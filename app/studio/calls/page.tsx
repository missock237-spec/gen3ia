"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { StudioHeader } from "@/components/studio/studio-header";
import { useVisiblePolling } from "@/components/hooks/use-visible-polling";

/**
 * Call App (/studio/calls) — appels vocaux IA pilotés par Bland AI.
 *
 * - Lancement d'appels sortants avec un agent vocal Gen3ia (synchronisé
 *   vers son agent Bland : prompt, personnalité, langue, voix) ;
 * - suivi en direct (statut + transcript rafraîchis depuis Bland) ;
 * - arrêt d'un appel en cours ;
 * - historique complet : transcription, enregistrement audio, résumé IA.
 */

interface CallRecord {
  id: string;
  agentId?: string | null;
  agentName?: string | null;
  to: string;
  status: string;
  completed: boolean;
  objective: string;
  language: string;
  lengthMinutes?: number | null;
  recordingUrl?: string | null;
  lastError?: string | null;
  history: Array<{ role: "assistant" | "user"; text: string; at: string }>;
  resume?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface AgentOption {
  id: string;
  name: string;
  voiceEnabled: boolean;
}

interface VoiceAgentStatus {
  id: string;
  name: string;
  language: string;
  blandAgentId: string | null;
  blandSyncedAt: string | null;
  blandSemver: string | null;
  stale: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  "in-progress": "bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]",
  completed: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  failed: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  busy: "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
  "no-answer": "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  canceled: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  unknown: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "En file",
  "in-progress": "En cours",
  completed: "Terminé",
  failed: "Échec",
  busy: "Occupé",
  "no-answer": "Sans réponse",
  canceled: "Annulé",
  unknown: "Inconnu",
};

const LIVE_STATUSES = new Set(["queued", "in-progress"]);

export default function StudioCallsPage() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentStatus, setAgentStatus] = useState<Record<string, VoiceAgentStatus>>({});
  const [configured, setConfigured] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [to, setTo] = useState("");
  const [objective, setObjective] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [liveCall, setLiveCall] = useState<CallRecord | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await authFetch("/api/voice/calls", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) {
        setCalls(data.calls ?? []);
        setConfigured(data.configured ?? true);
      }
    } catch {
      /* historique indisponible */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentsResponse, statusResponse] = await Promise.all([
          authFetch("/api/agents", { cache: "no-store" }),
          authFetch("/api/voice/status", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        const agentsData = await agentsResponse.json();
        if (agentsResponse.ok) {
          const list = (agentsData.agents ?? []) as AgentOption[];
          setAgents(list);
          const voiceAgent = list.find((agent) => agent.voiceEnabled);
          setSelectedAgent((current) => current || voiceAgent?.id || "");
        }
        if (statusResponse.ok) {
          const statusData = await statusResponse.json();
          setConfigured(statusData.configured ?? true);
          const byId: Record<string, VoiceAgentStatus> = {};
          for (const agent of (statusData.agents ?? []) as VoiceAgentStatus[]) byId[agent.id] = agent;
          setAgentStatus(byId);
        }
      } catch {
        /* liste agents indisponible */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Suivi d'appel en direct : interrogation partagée par le premier
  // chargement et le sondage visibilité-gaté — arrêté dès statut terminal.
  const pollLiveCall = useCallback(async () => {
    if (!openId) return;
    try {
      const response = await authFetch(`/api/voice/calls/${encodeURIComponent(openId)}`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok && data.id) {
        const record = data as CallRecord;
        setLiveCall(record);
        if (!LIVE_STATUSES.has(record.status)) void load();
      }
    } catch {
      /* continuation de polling */
    }
  }, [openId, load]);

  useEffect(() => {
    setLiveCall(null);
    if (openId) void pollLiveCall();
  }, [openId, pollLiveCall]);

  const liveTracking =
    openId !== null &&
    (liveCall === null || liveCall.id !== openId || LIVE_STATUSES.has(liveCall.status));
  useVisiblePolling(pollLiveCall, liveTracking ? 4_000 : null);

  async function startCall() {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authFetch("/api/voice/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgent, to, ...(objective.trim() ? { objective: objective.trim() } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Appel impossible.");
      setMessage(`Appel lancé vers ${data.to} — l'agent Bland prend le relais.`);
      setOpenId(data.sessionId);
      setTo("");
      setObjective("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Appel impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function stopCall(callId: string) {
    setError("");
    try {
      const response = await authFetch(`/api/voice/calls/${encodeURIComponent(callId)}/stop`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Arrêt impossible.");
      setMessage("Appel arrêté.");
      await load();
      await pollLiveCall();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Arrêt impossible.");
    }
  }

  async function requestSummary(callId: string, refresh = false) {
    setSummaryBusy(true);
    setError("");
    try {
      const response = await authFetch(`/api/voice/calls/${encodeURIComponent(callId)}/summary${refresh ? "?refresh=1" : ""}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Résumé indisponible.");
      setSummary(data.summary);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Résumé indisponible.");
    } finally {
      setSummaryBusy(false);
    }
  }

  async function syncAgent(agentId: string) {
    if (syncBusy) return;
    setSyncBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/voice/sync`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Synchronisation impossible.");
      setMessage(`Agent synchronisé avec Bland (version ${data.semver}).`);
      const statusResponse = await authFetch("/api/voice/status", { cache: "no-store" });
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        const byId: Record<string, VoiceAgentStatus> = {};
        for (const agent of (statusData.agents ?? []) as VoiceAgentStatus[]) byId[agent.id] = agent;
        setAgentStatus(byId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Synchronisation impossible.");
    } finally {
      setSyncBusy(false);
    }
  }

  const inputClass = "w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3 py-2 text-sm";
  const labelClass = "block text-xs font-semibold text-[var(--g3-muted)] mb-1";
  const voiceAgents = agents.filter((agent) => agent.voiceEnabled);
  const selectedStatus = selectedAgent ? agentStatus[selectedAgent] : undefined;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <StudioHeader
        eyebrow="STUDIO · CALL APP · BLAND AI"
        title="Appels IA"
        description="Lancez des appels vocaux avec vos agents : chaque agent Gen3ia est synchronisé avec son agent Bland AI (prompt, personnalité, langue) qui conduit la conversation téléphonique."
      />

      {error && <div className="mb-4 rounded-xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">{error}</div>}
      {message && <div className="mb-4 rounded-xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">{message}</div>}
      {!configured && (
        <div className="mb-4 rounded-xl border border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] px-4 py-3 text-sm text-[var(--g3-warning-strong)]" role="alert">
          Clé API Bland manquante (BLAND_API_KEY) : les appels vocaux sont désactivés. Ajoutez-la dans les variables d&apos;environnement.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
          <h2 className="mb-3 text-base font-bold">Nouvel appel</h2>
          {voiceAgents.length === 0 ? (
            <p className="text-sm text-[var(--g3-muted)]">
              Aucun agent vocal. Activez la voix sur un agent (type « Vocal » ou configuration vocale), puis revenez lancer l&apos;appel.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <label className={labelClass}>Agent vocal</label>
                <select className={inputClass} value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
                  {voiceAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </div>
              {selectedStatus && (
                <div className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-xs">
                  {selectedStatus.blandAgentId ? (
                    <p className={selectedStatus.stale ? "text-[var(--g3-warning-strong)]" : "text-[var(--g3-success-strong)]"}>
                      {selectedStatus.stale
                        ? "⟳ Configuration modifiée — resynchronisation automatique avant l'appel."
                        : `✓ Synchronisé avec Bland (version ${selectedStatus.blandSemver ?? "?"}).`}
                    </p>
                  ) : (
                    <p className="text-[var(--g3-muted)]">Agent Bland créé automatiquement au premier appel.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void syncAgent(selectedAgent)}
                    disabled={syncBusy}
                    className="mt-1.5 text-[11px] font-semibold text-[var(--g3-info)] underline disabled:opacity-50"
                  >
                    {syncBusy ? "Synchronisation…" : "Resynchroniser maintenant"}
                  </button>
                </div>
              )}
              <div>
                <label className={labelClass}>Numéro du correspondant (+E164)</label>
                <input className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} placeholder="+2376XXXXXXXX" />
              </div>
              <div>
                <label className={labelClass}>Objectif de l&apos;appel</label>
                <textarea className={inputClass} rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={4_000} placeholder="Confirmer le rendez-vous de demain à 15h…" />
              </div>
              <button
                type="button"
                onClick={() => void startCall()}
                disabled={busy || !selectedAgent || !to.trim() || !configured}
                className="rounded-xl bg-[var(--g3-deep)] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
              >
                {busy ? "Lancement…" : "Lancer l'appel"}
              </button>
              <p className="text-[11px] leading-relaxed text-[var(--g3-muted)]">
                L&apos;appel est conduit par l&apos;agent Bland synchronisé ; il est enregistré et transcrit.
              </p>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
          <h2 className="mb-3 text-base font-bold">Historique des appels</h2>
          {loading ? (
            <p className="text-sm text-[var(--g3-muted)]">Chargement…</p>
          ) : calls.length === 0 ? (
            <p className="text-sm text-[var(--g3-muted)]">Aucun appel pour le moment.</p>
          ) : (
            <ul className="grid gap-2">
              {calls.map((record) => (
                <li key={record.id} className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {record.to}
                        {record.agentName ? <span className="ml-2 text-xs font-normal text-[var(--g3-muted)]">· {record.agentName}</span> : null}
                      </p>
                      <p className="text-xs text-[var(--g3-muted)]">
                        {new Date(record.createdAt).toLocaleString("fr-FR")}
                        {record.lengthMinutes ? ` · ${Math.round(record.lengthMinutes)} min` : ""}
                        {" · "}
                        {record.objective.slice(0, 60)}{record.objective.length > 60 ? "…" : ""}
                      </p>
                    </div>
                    <span className={"shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold " + (STATUS_STYLES[record.status] ?? "bg-[var(--g3-elevated)]")}>
                      {STATUS_LABELS[record.status] ?? record.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenId(openId === record.id ? null : record.id);
                        setSummary(record.resume ?? null);
                      }}
                      className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold"
                    >
                      {openId === record.id ? "Fermer" : LIVE_STATUSES.has(record.status) ? "Suivre en direct" : "Transcript"}
                    </button>
                    {LIVE_STATUSES.has(record.status) && openId === record.id && (
                      <button
                        type="button"
                        onClick={() => void stopCall(record.id)}
                        className="rounded-lg border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-3 py-1.5 text-xs font-bold text-[var(--g3-danger-strong)]"
                      >
                        Arrêter l&apos;appel
                      </button>
                    )}
                    {!LIVE_STATUSES.has(record.status) && record.status === "completed" && (
                      <button
                        type="button"
                        onClick={() => void requestSummary(record.id)}
                        disabled={summaryBusy}
                        className="rounded-lg bg-[var(--g3-deep)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        {summaryBusy ? "…" : record.resume ? "Voir le résumé" : "Résumé IA"}
                      </button>
                    )}
                  </div>

                  {openId === record.id && (
                    <div className="mt-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-3">
                      {liveCall && LIVE_STATUSES.has(liveCall.status) && (
                        <p className="mb-2 text-xs font-bold text-[var(--g3-info)]">● Appel {STATUS_LABELS[liveCall.status] ?? liveCall.status} — transcript en direct</p>
                      )}
                      {(liveCall?.lastError ?? record.lastError) && (
                        <p className="mb-2 text-xs text-[var(--g3-danger-strong)]">Erreur : {(liveCall?.lastError ?? record.lastError)}</p>
                      )}
                      <div className="max-h-64 space-y-1.5 overflow-y-auto">
                        {(liveCall?.history ?? record.history ?? []).length === 0 && (
                          <p className="text-xs text-[var(--g3-muted)]">Aucun échange enregistré pour l&apos;instant.</p>
                        )}
                        {(liveCall?.history ?? record.history ?? []).map((item, index) => (
                          <p key={index} className={"text-xs " + (item.role === "assistant" ? "text-[var(--g3-success-strong)]" : "text-[var(--g3-text)]")}>
                            <strong>{item.role === "assistant" ? "Agent" : "Correspondant"} :</strong> {item.text}
                          </p>
                        ))}
                      </div>
                      {(liveCall?.recordingUrl ?? record.recordingUrl) && (
                        <div className="mt-3">
                          <p className="mb-1 text-[11px] font-bold text-[var(--g3-muted)]">Enregistrement</p>
                                          <audio controls preload="none" className="w-full" src={(liveCall?.recordingUrl ?? record.recordingUrl) ?? undefined} />
                        </div>
                      )}
                      {summary && (
                        <div className="mt-3 rounded-lg border border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] p-3">
                          <p className="mb-1 text-xs font-bold text-[var(--g3-info)]">Résumé IA</p>
                          <p className="whitespace-pre-wrap text-xs text-[var(--g3-info)]">{summary}</p>
                          <button type="button" onClick={() => void requestSummary(record.id, true)} disabled={summaryBusy} className="mt-2 text-[11px] font-semibold text-[var(--g3-info)] underline">
                            {summaryBusy ? "…" : "Régénérer"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
