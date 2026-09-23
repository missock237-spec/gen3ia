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
  // Agent « toujours actif » : mode de déclenchement + sources de veille.
  const [triggerMode, setTriggerMode] = useState<"cron" | "webhook" | "watch">("cron");
  const [watchSources, setWatchSources] = useState<Array<{ type: "rss" | "web"; url: string; label: string }>>(
    [{ type: "rss", url: "", label: "" }],
  );

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

  const valid =
    name.trim().length > 0 &&
    agentId.trim().length > 0 &&
    objective.trim().length >= 3 &&
    (triggerMode === "cron"
      ? selectedDays.length > 0
      : triggerMode === "webhook"
        ? true
        : watchSources.some((source) => source.url.trim().length > 8));

  const submit = async () => {
    if (!valid || busy) return;
    await onCreate({
      name: name.trim(), agentId, objective: objective.trim(), timezone, daysOfWeek: selectedDays,
      startTime, endTime, intervalMinutes, maxRetries, retryDelayMinutes, catchUp, maxCatchUpRuns,
      ...(triggerMode === "webhook" ? { enableWebhook: true } : {}),
      ...(triggerMode === "watch"
        ? { watchSourceInputs: watchSources.filter((source) => source.url.trim().length > 8).map(({ type, url, label }) => ({ type, url: url.trim(), ...(label.trim() ? { label: label.trim() } : {}) })) }
        : {}),
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
          <legend className="g3-label">Déclencheur</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {([
              { key: "cron", title: "Planifié", detail: "Jours + fenêtre horaire (cron)" },
              { key: "webhook", title: "Webhook", detail: "Un appel d'URL externe déclenche l'agent" },
              { key: "watch", title: "Veille RSS / Web", detail: "Détecte les changements d'une source" },
            ] as const).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setTriggerMode(option.key)}
                aria-pressed={triggerMode === option.key}
                className={`rounded-xl border p-3 text-left transition-colors ${triggerMode === option.key ? "border-sky-200 bg-sky-100 text-sky-800" : "border-[var(--g3-border)] bg-neutral-50 hover:bg-neutral-100"}`}
              >
                <span className="block text-sm font-semibold">{option.title}</span>
                <span className="mt-0.5 block text-xs text-neutral-500">{option.detail}</span>
              </button>
            ))}
          </div>
          {triggerMode === "webhook" ? (
            <p className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
              L&apos;URL du webhook (avec token secret) sera affichée sur la carte après enregistrement. Chaque POST déclenche la mission ; l&apos;agent vous notifie à la fin.
            </p>
          ) : null}
          {triggerMode === "watch" ? (
            <div className="mt-2 space-y-2">
              {watchSources.map((source, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[110px_1fr_1fr_40px]">
                  <select
                    value={source.type}
                    onChange={(e) => setWatchSources((current) => current.map((item, i) => (i === index ? { ...item, type: e.target.value as "rss" | "web" } : item)))}
                    className="g3-select"
                    aria-label={`Type de la source ${index + 1}`}
                  >
                    <option value="rss">Flux RSS</option>
                    <option value="web">Page web</option>
                  </select>
                  <input
                    value={source.url}
                    onChange={(e) => setWatchSources((current) => current.map((item, i) => (i === index ? { ...item, url: e.target.value } : item)))}
                    placeholder="https://exemple.com/flux"
                    className="g3-input"
                    aria-label={`URL de la source ${index + 1}`}
                    maxLength={2000}
                  />
                  <input
                    value={source.label}
                    onChange={(e) => setWatchSources((current) => current.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)))}
                    placeholder="Libellé (optionnel)"
                    className="g3-input"
                    aria-label={`Libellé de la source ${index + 1}`}
                    maxLength={120}
                  />
                  <button type="button" onClick={() => setWatchSources((current) => current.filter((_, i) => i !== index))} className="rounded-xl border border-neutral-300 text-neutral-400 hover:bg-neutral-100" aria-label={`Retirer la source ${index + 1}`}>×</button>
                </div>
              ))}
              {watchSources.length < 5 ? (
                <button type="button" onClick={() => setWatchSources((current) => [...current, { type: "rss", url: "", label: "" }])} className="text-xs font-semibold text-sky-700 hover:underline">
                  + Ajouter une source ({watchSources.length}/5)
                </button>
              ) : null}
              <p className="text-xs text-neutral-400">À la première vérification, la baseline est enregistrée sans déclencher l&apos;agent. Ensuite, tout changement de contenu lance la mission.</p>
            </div>
          ) : null}
        </fieldset>

        {triggerMode === "cron" ? (
          <>
        <fieldset className="mt-5">
          <legend className="g3-label">Jours actifs</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                onClick={() => toggleDay(value)}
                aria-pressed={selectedDays.includes(value)}
                className={`rounded-xl border px-3 py-2 text-sm transition-colors ${selectedDays.includes(value) ? "border-sky-200 bg-sky-100 text-sky-700" : "border-[var(--g3-border)] bg-neutral-50 text-neutral-500 hover:bg-neutral-100"}`}
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
          </>
        ) : null}

        <div className="mt-4">
          <label className="g3-label" htmlFor="schedule-timezone">Fuseau horaire</label>
          <input id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Africa/Douala" className="g3-input" />
        </div>

        {triggerMode === "cron" ? (
          <div className="mt-4 rounded-xl border border-[var(--g3-border)] bg-neutral-50 p-3 text-sm text-neutral-600" aria-live="polite">
            {summary} · {timezone}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-[var(--g3-border)] bg-neutral-50 p-3 text-sm text-neutral-600" aria-live="polite">
            {triggerMode === "webhook" ? "Déclenchement par événement externe (webhook)" : `Veille active sur ${watchSources.filter((source) => source.url.trim().length > 8).length} source(s)`} · {timezone}
          </div>
        )}

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
