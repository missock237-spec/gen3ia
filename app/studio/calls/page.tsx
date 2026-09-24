"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { StudioHeader } from "@/components/studio/studio-header";

/**
 * Call App évoluée (/studio/calls).
 *
 * Hub d'appels IA : historique complet, lancement d'appels sortants
 * (agent vocal + numéro attribué), suivi d'un appel en direct (statut +
 * transcript rafraîchi), résumé IA post-appel facturé au propriétaire et
 * mis en cache.
 */

interface CallSession {
  id: string;
  agentId?: string;
  to: string;
  from: string;
  objective: string;
  language: string;
  status: string;
  provider?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  history: Array<{ role: "assistant" | "user"; text: string; at: string }>;
  resume?: string;
}

interface AgentOption {
  id: string;
  name: string;
  voiceEnabled: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  ringing: "bg-amber-50 text-amber-700",
  "in-progress": "bg-sky-50 text-sky-700",
  completed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  "no-answer": "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  busy: "bg-amber-50 text-amber-700",
  canceled: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
};

const LIVE_STATUSES = new Set(["queued", "ringing", "in-progress"]);

export default function StudioCallsPage() {
  const [sessions, setSessions] = useState<CallSession[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [to, setTo] = useState("");
  const [objective, setObjective] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [liveSession, setLiveSession] = useState<CallSession | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authFetch("/api/voice/calls", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setSessions(data.sessions ?? []);
    } catch { /* historique indisponible */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authFetch("/api/agents", { cache: "no-store" });
        const data = await response.json();
        if (cancelled || !response.ok) return;
        const list = (data.agents ?? []) as Array<{ id: string; name: string; voiceEnabled: boolean }>;
        setAgents(list);
        const voiceAgent = list.find((agent) => agent.voiceEnabled);
        setSelectedAgent((current) => current || voiceAgent?.id || "");
      } catch { /* liste agents indisponible */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Suivi d'appel en direct : polling léger tant qu'un appel est vivant.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!openId) { setLiveSession(null); return; }
    const poll = async () => {
      try {
        const response = await authFetch(`/api/voice/calls/${encodeURIComponent(openId)}`, { cache: "no-store" });
        const data = await response.json();
        if (response.ok && data.session) {
          setLiveSession(data.session);
          if (!LIVE_STATUSES.has(data.session.status)) void load();
        }
      } catch { /* continuation de polling */ }
    };
    void poll();
    pollRef.current = setInterval(poll, 4_000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [openId, load]);

  async function startCall() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/voice/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgent, to, ...(objective.trim() ? { objective: objective.trim() } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Appel impossible.");
      setMessage(`Appel lancé vers ${data.to} (${data.status}).`);
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

  async function requestSummary(callId: string, refresh = false) {
    setSummaryBusy(true); setError("");
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

  const inputClass = "w-full rounded-xl border border-[rgba(23,23,20,0.12)] bg-[var(--g3-surface)] px-3 py-2 text-sm";
  const labelClass = "block text-xs font-semibold text-[var(--g3-muted)] mb-1";
  const voiceAgents = agents.filter((agent) => agent.voiceEnabled);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <StudioHeader
        eyebrow="STUDIO · CALL APP"
        title="Appels IA"
        description="Lancez des appels sortants avec vos agents vocaux, suivez les conversations en direct et obtenez un résumé IA de chaque appel."
      />

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>}
      {message && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{message}</div>}

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <section className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-5">
          <h2 className="mb-3 text-base font-bold">Nouvel appel</h2>
          {voiceAgents.length === 0 ? (
            <p className="text-sm text-[var(--g3-muted)]">
              Aucun agent vocal. Activez la voix sur un agent et attribuez-lui un numéro (Paramètres · Numéros virtuels).
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <label className={labelClass}>Agent vocal</label>
                <select className={inputClass} value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
                  {voiceAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass}>Numéro du correspondant (+E164)</label>
                <input className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} placeholder="+2376XXXXXXXX" />
              </div>
              <div>
                <label className={labelClass}>Objectif de l&apos;appel</label>
                <textarea className={inputClass} rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={4_000} placeholder="Confirmer le rendez-vous de demain à 15h…" />
              </div>
              <button type="button" onClick={() => void startCall()} disabled={busy || !selectedAgent || !to.trim()} className="rounded-xl bg-[var(--g3-deep)] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                {busy ? "Lancement…" : "Lancer l'appel"}
              </button>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-5">
          <h2 className="mb-3 text-base font-bold">Historique des appels</h2>
          {loading ? (
            <p className="text-sm text-[var(--g3-muted)]">Chargement…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-[var(--g3-muted)]">Aucun appel pour le moment.</p>
          ) : (
            <ul className="grid gap-2">
              {sessions.map((session) => (
                <li key={session.id} className="rounded-xl border border-[rgba(23,23,20,0.1)] bg-[var(--g3-elevated)] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{session.to}</p>
                      <p className="text-xs text-[var(--g3-muted)]">
                        {new Date(session.createdAt).toLocaleString("fr-FR")} · {session.objective.slice(0, 60)}{session.objective.length > 60 ? "…" : ""}
                      </p>
                    </div>
                    <span className={"shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold " + (STATUS_STYLES[session.status] ?? "bg-[var(--g3-elevated)]")}>
                      {session.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => { setOpenId(openId === session.id ? null : session.id); setSummary(session.resume ?? null); }} className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold">
                      {openId === session.id ? "Fermer" : LIVE_STATUSES.has(session.status) ? "Suivre en direct" : "Transcript"}
                    </button>
                    {!LIVE_STATUSES.has(session.status) && session.status === "completed" && (
                      <button type="button" onClick={() => void requestSummary(session.id)} disabled={summaryBusy} className="rounded-lg bg-[var(--g3-deep)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                        {summaryBusy ? "…" : session.resume ? "Voir le résumé" : "Résumé IA"}
                      </button>
                    )}
                  </div>

                  {openId === session.id && (
                    <div className="mt-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-3">
                      {liveSession && LIVE_STATUSES.has(liveSession.status) && (
                        <p className="mb-2 text-xs font-bold text-sky-700">● Appel {liveSession.status} — transcript en direct</p>
                      )}
                      {liveSession?.lastError && <p className="mb-2 text-xs text-red-600">Erreur : {liveSession.lastError}</p>}
                      <div className="max-h-64 space-y-1.5 overflow-y-auto">
                        {(liveSession?.history ?? session.history ?? []).length === 0 && (
                          <p className="text-xs text-[var(--g3-muted)]">Aucun échange enregistré pour l&apos;instant.</p>
                        )}
                        {(liveSession?.history ?? session.history ?? []).map((item, index) => (
                          <p key={index} className={"text-xs " + (item.role === "assistant" ? "text-emerald-800" : "text-[var(--g3-text)]")}>
                            <strong>{item.role === "assistant" ? "Agent" : "Correspondant"} :</strong> {item.text}
                          </p>
                        ))}
                      </div>
                      {summary && (
                        <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
                          <p className="mb-1 text-xs font-bold text-sky-900">Résumé IA</p>
                          <p className="whitespace-pre-wrap text-xs text-sky-900">{summary}</p>
                          <button type="button" onClick={() => void requestSummary(session.id, true)} disabled={summaryBusy} className="mt-2 text-[11px] font-semibold text-sky-700 underline">
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
