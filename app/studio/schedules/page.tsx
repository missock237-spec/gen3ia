"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

type Agent = { id: string; name: string; status: string; type: string; };\n\ntype Schedule = {
  id: string;
  agentId: string;
  name: string;
  objective: string;
  timezone: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  intervalMinutes: number;
  enabled: boolean;
  lastExecutionStatus?: string;
  lastExecutionAt?: string;
  lastError?: string;
};

const days = [
  [1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"], [6, "Sam"], [0, "Dim"],
] as const;

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

export default function AgentSchedulesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [objective, setObjective] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("18:00");
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const sessionDisponible = useSessionAvailable();

  const load = async () => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    const [response, agentsResponse] = await Promise.all([
      authFetch("/api/agents/schedules", { cache: "no-store" }),
      authFetch("/api/agents", { cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error((await response.json()).error ?? "Chargement impossible");
    if (agentsResponse.ok) {
      const agentData = await agentsResponse.json();
      setAgents((agentData.agents ?? []).filter((agent: Agent) => agent.status === "active"));
    }
    setSchedules((await response.json()).schedules ?? []);
  };

  useEffect(() => {
    // Differe d'un tick pour eviter un rendu en cascade synchrone (set-state-in-effect).
    const timer = setTimeout(() => setTimezone(browserTimezone()), 0);
    const unsubscribe = onAuthStateChanged(auth, async (current) => {
      setUser(current);
      try { await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Chargement impossible"); }
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, []);

  const summary = useMemo(() => {
    const selected = days.filter(([value]) => selectedDays.includes(value)).map(([, label]) => label);
    return `${selected.join(", ")} · ${startTime} → ${endTime}`;
  }, [selectedDays, startTime, endTime]);

  const toggleDay = (day: number) => {
    setSelectedDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());
  };

  const create = async () => {
    if (sessionDisponible === false) { setMessage("Session expirée. Reconnectez-vous."); return; }
    if (!name.trim() || !agentId.trim() || objective.trim().length < 3 || selectedDays.length === 0) return;
    setBusy(true); setMessage("");
    try {
      const response = await authFetch("/api/agents/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, agentId, objective, timezone, daysOfWeek: selectedDays,
          startTime, endTime, intervalMinutes, enabled: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Création impossible");
      setSchedules((current) => [data.schedule, ...current]);
      setName(""); setAgentId(""); setObjective(""); setMessage("Planification enregistrée.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Création impossible"); }
    finally { setBusy(false); }
  };

  const toggle = async (schedule: Schedule) => {
    if (sessionDisponible === false) return;
    setBusy(true); setMessage("");
    try {
      const response = await authFetch(`/api/agents/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Modification impossible");
      setSchedules((current) => current.map((item) => item.id === schedule.id ? data.schedule : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Modification impossible"); }
    finally { setBusy(false); }
  };

  const remove = async (schedule: Schedule) => {
    if (sessionDisponible === false || !window.confirm(`Supprimer « ${schedule.name} » ?`)) return;
    setBusy(true); setMessage("");
    try {
      const response = await authFetch(`/api/agents/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Suppression impossible");
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Suppression impossible"); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-full bg-[#f6f4ef] p-5 text-neutral-900 md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="g3-eyebrow">GEN3IA · AUTOMATION</div>
            <h1 className="mt-2 font-serif text-3xl font-semibold">Planification des agents</h1>
            <p className="mt-2 max-w-2xl text-neutral-500">Définissez les jours et la fenêtre horaire pendant lesquels un agent peut être activé automatiquement. Le serveur applique la fenêtre et le fuseau horaire, même si l’utilisateur ferme l’application.</p>
          </div>
          <Link href="/studio" className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-4 py-2 text-sm hover:bg-neutral-100">← Retour au Studio</Link>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
          <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Nouvelle planification</h2><span className="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-xs text-emerald-600">Fuseau serveur contrôlé</span></div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-sm text-neutral-600">Nom<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent du matin" className="g3-input mt-2" /></label>
              <label className="text-sm text-neutral-600">Agent
                <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="g3-input mt-2">
                  <option value="">Sélectionner un agent actif</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id.slice(0, 8)}</option>)}
                </select>
              </label>
            </div>
            <label className="mt-4 block text-sm text-neutral-600">Objectif<textarea value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Ex. Surveille les nouveautés de mon secteur et prépare un rapport." className="g3-textarea mt-2 min-h-28" /></label>
            <div className="mt-5"><div className="text-sm text-neutral-600">Jours actifs</div><div className="mt-2 flex flex-wrap gap-2">{days.map(([value, label]) => <button type="button" key={value} onClick={() => toggleDay(value)} className={`rounded-xl border px-3 py-2 text-sm ${selectedDays.includes(value) ? "border-sky-200 bg-sky-100 text-sky-700" : "border-[rgba(23,23,20,0.09)] bg-neutral-50 text-neutral-500"}`}>{label}</button>)}</div></div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <label className="text-sm text-neutral-600">Activation<input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="g3-input mt-2" /></label>
              <label className="text-sm text-neutral-600">Arrêt<input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="g3-input mt-2" /></label>
              <label className="text-sm text-neutral-600">Répétition<input type="number" min={0} max={1440} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))} className="g3-input mt-2" /><span className="mt-1 block text-xs text-neutral-400">0 = une activation au début de la fenêtre</span></label>
            </div>
            <label className="mt-4 block text-sm text-neutral-600">Fuseau horaire<input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Africa/Douala" className="g3-input mt-2" /></label>
            <div className="mt-4 rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3 text-sm text-neutral-600">{summary} · {timezone}</div>
            <button disabled={busy || !user || !name.trim() || !agentId.trim() || objective.trim().length < 3 || selectedDays.length === 0} onClick={create} className="g3-btn g3-btn-primary mt-4 w-full">Enregistrer la planification</button>
            {message && <div className="mt-4 rounded-xl border border-violet-200 bg-violet-100 p-3 text-sm text-violet-700">{message}</div>}
          </div>

          <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <h2 className="font-serif text-xl font-semibold">Vos planifications</h2>
            <p className="mt-2 text-sm text-neutral-500">La planification est stockée dans Firestore et traitée côté serveur.</p>
            <div className="mt-5 space-y-3">
              {schedules.length === 0 ? <div className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400">Aucune planification.</div> : schedules.map((schedule) => <article key={schedule.id} className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{schedule.name}</h3><p className="mt-1 text-xs text-neutral-400">{schedule.agentId}</p></div><span className={`rounded-full px-2 py-1 text-[10px] uppercase ${schedule.enabled ? "bg-emerald-100 text-emerald-600" : "bg-neutral-200/70 text-neutral-500"}`}>{schedule.enabled ? "active" : "pause"}</span></div><p className="mt-3 line-clamp-2 text-sm text-neutral-500">{schedule.objective}</p><div className="mt-3 text-xs text-neutral-500">{days.filter(([value]) => schedule.daysOfWeek.includes(value)).map(([, label]) => label).join(" · ")} · {schedule.startTime} → {schedule.endTime}</div><div className="mt-1 text-xs text-neutral-400">{schedule.timezone}{schedule.intervalMinutes ? ` · toutes les ${schedule.intervalMinutes} min` : " · au début de la fenêtre"}</div>
                  <div className="mt-2 text-xs">
                    {schedule.lastExecutionStatus === "running" ? <span className="text-amber-600">Exécution en cours…</span> : schedule.lastExecutionStatus ? <span className={schedule.lastExecutionStatus === "completed" ? "text-emerald-600" : "text-red-600"}>Dernière exécution : {schedule.lastExecutionStatus}{schedule.lastExecutionAt ? ` · ${new Date(schedule.lastExecutionAt).toLocaleString()}` : ""}</span> : <span className="text-neutral-400">Aucune exécution</span>}
                  </div>
                  {schedule.lastError && <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-600">{schedule.lastError}</div>}<div className="mt-4 flex gap-2"><button disabled={busy} onClick={() => toggle(schedule)} className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-white px-3 py-2 text-xs hover:bg-neutral-100">{schedule.enabled ? "Mettre en pause" : "Activer"}</button><button disabled={busy} onClick={() => remove(schedule)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 hover:bg-red-100">Supprimer</button></div></article>)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
