"use client";

import { useEffect, useMemo, useState } from "react";

import { DAYS, browserTimezone, type Agent, type ScheduleDraft } from "@/components/studio/schedule-types";

/**
 * Formulaire « Nouvelle planification » (extrait de app/studio/schedules/page.tsx).
 * Champs contrôlés auto-contenus ; remonte un ScheduleDraft au parent via onCreate.
 */
export function ScheduleForm({
  agents,
  busy,
  userReady,
  onCreate,
}: {
  agents: Agent[];
  busy: boolean;
  userReady: boolean;
  onCreate: (draft: ScheduleDraft) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [objective, setObjective] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("18:00");
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const [maxRetries, setMaxRetries] = useState(2);
  const [retryDelayMinutes, setRetryDelayMinutes] = useState(5);
  const [catchUp, setCatchUp] = useState(false);
  const [maxCatchUpRuns, setMaxCatchUpRuns] = useState(1);

  // Fuseau du navigateur appliqué après montage, différé d'un tick
  // (évite le rendu en cascade synchrone — pattern établi du codebase).
  useEffect(() => {
    const timer = window.setTimeout(() => setTimezone(browserTimezone()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const summary = useMemo(() => {
    const selected = DAYS.filter(([value]) => selectedDays.includes(value)).map(([, label]) => label);
    return `${selected.join(", ")} · ${startTime} → ${endTime}`;
  }, [selectedDays, startTime, endTime]);

  const toggleDay = (day: number) => {
    setSelectedDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());
  };

  const valid = name.trim().length > 0 && agentId.trim().length > 0 && objective.trim().length >= 3 && selectedDays.length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    await onCreate({
      name: name.trim(), agentId, objective: objective.trim(), timezone, daysOfWeek: selectedDays,
      startTime, endTime, intervalMinutes, maxRetries, retryDelayMinutes, catchUp, maxCatchUpRuns,
    });
    setName(""); setAgentId(""); setObjective("");
  };

  return (
    <div className="g3-card p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xl font-semibold">Nouvelle planification</h2>
        <span className="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-xs text-emerald-600">Fuseau serveur contrôlé</span>
      </div>

      <form
        className="mt-5"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="g3-label" htmlFor="schedule-name">Nom</label>
            <input id="schedule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent du matin" className="g3-input" maxLength={120} />
          </div>
          <div>
            <label className="g3-label" htmlFor="schedule-agent">Agent</label>
            <select id="schedule-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="g3-select">
              <option value="">Sélectionner un agent actif</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id.slice(0, 8)}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <label className="g3-label" htmlFor="schedule-objective">Objectif</label>
          <textarea id="schedule-objective" value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Ex. Surveille les nouveautés de mon secteur et prépare un rapport." className="g3-textarea min-h-28" maxLength={20_000} />
        </div>

        <fieldset className="mt-5">
          <legend className="g3-label">Jours actifs</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                onClick={() => toggleDay(value)}
                aria-pressed={selectedDays.includes(value)}
                className={`rounded-xl border px-3 py-2 text-sm transition-colors ${selectedDays.includes(value) ? "border-sky-200 bg-sky-100 text-sky-700" : "border-[rgba(23,23,20,0.09)] bg-neutral-50 text-neutral-500 hover:bg-neutral-100"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div>
            <label className="g3-label" htmlFor="schedule-start">Activation</label>
            <input id="schedule-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="g3-input" />
          </div>
          <div>
            <label className="g3-label" htmlFor="schedule-end">Arrêt</label>
            <input id="schedule-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="g3-input" />
          </div>
          <div>
            <label className="g3-label" htmlFor="schedule-interval">Répétition (min)</label>
            <input id="schedule-interval" type="number" min={0} max={1440} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))} className="g3-input" aria-describedby="schedule-interval-hint" />
            <span id="schedule-interval-hint" className="mt-1 block text-xs text-neutral-400">0 = une activation au début de la fenêtre</span>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div>
            <label className="g3-label" htmlFor="schedule-retries">Retries automatiques</label>
            <input id="schedule-retries" type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))} className="g3-input" />
          </div>
          <div>
            <label className="g3-label" htmlFor="schedule-retry-delay">Délai entre retries (min)</label>
            <input id="schedule-retry-delay" type="number" min={1} max={1440} value={retryDelayMinutes} onChange={(e) => setRetryDelayMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))} className="g3-input" />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
            Rattraper les exécutions manquées
          </label>
          {catchUp && (
            <label className="flex items-center gap-2">
              Maximum
              <input type="number" min={0} max={10} value={maxCatchUpRuns} onChange={(e) => setMaxCatchUpRuns(Math.max(0, Math.min(10, Number(e.target.value) || 0)))} className="w-20 rounded-lg border border-[rgba(23,23,20,0.16)] p-2" aria-label="Nombre maximum d'exécutions rattrapées" />
            </label>
          )}
        </div>

        <div className="mt-4">
          <label className="g3-label" htmlFor="schedule-timezone">Fuseau horaire</label>
          <input id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Africa/Douala" className="g3-input" />
        </div>

        <div className="mt-4 rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3 text-sm text-neutral-600" aria-live="polite">
          {summary} · {timezone}
        </div>

        <button
          type="submit"
          disabled={busy || !userReady || !valid}
          className="g3-btn g3-btn-primary mt-4 w-full"
        >
          {busy ? <>Enregistrement<span className="g3-dots"><span /><span /><span /></span></> : "Enregistrer la planification"}
        </button>
      </form>
    </div>
  );
}
