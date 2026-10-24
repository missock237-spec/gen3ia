"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";

/**
 * Espace Automatisations — console client.
 *
 * Deux sections d'un même espace de travail (demande propriétaire) :
 *  - Agents : les agents dédiés qui exécutent l'opérationnel ;
 *  - Planifications : tâches récurrentes ou ponctuelles rattachées à un
 *    agent (fenêtre quotidienne, intervalle, one-shot) + historique
 *    d'exécutions, activation et déclenchement manuel.
 *
 * Les routes d'ORCHESTRATION restent réservées au système : cette console
 * liste, crée (provisionnement standard), active/désactive, déclenche à la
 * demande (endpoint manuel prévu pour) et supprime — elle ne pilote jamais
 * l'exécution elle-même.
 */

type TabId = "agents" | "planifications";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "planifications", label: "Planifications" },
];

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  type: string;
  typeLabel?: string;
  status: string;
  autonomous: boolean;
  tools: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface AgentSchedule {
  id: string;
  agentId: string;
  name: string;
  objective: string;
  timezone: string;
  daysOfWeek?: number[];
  startTime?: string;
  endTime?: string;
  intervalMinutes?: number;
  runAtMs?: number;
  enabled: boolean;
  lastExecutionStatus?: string;
  lastExecutionAt?: string;
  lastError?: string;
  nextRunAt?: string;
  createdAt?: string;
}

interface ScheduleRun {
  id: string;
  slot: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const DAYS = [
  { value: 1, label: "L" },
  { value: 2, label: "M" },
  { value: 3, label: "M" },
  { value: 4, label: "J" },
  { value: 5, label: "V" },
  { value: 6, label: "S" },
  { value: 0, label: "D" },
];

const RUN_STATUS_CLASS: Record<string, string> = {
  success: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  succeeded: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  completed: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  failed: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  error: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  running: "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]",
  pending: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  skipped: "bg-[var(--g3-elevated)] text-[var(--g3-faint)]",
};

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className ?? "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
      {label}
    </span>
  );
}

const formatDateFr = (value?: string | number | null): string => {
  if (value == null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

const descriptionFenetre = (schedule: AgentSchedule): string => {
  const jours = schedule.daysOfWeek?.length
    ? schedule.daysOfWeek.map((d) => DAYS.find((day) => day.value === d)?.label ?? String(d)).join(" ")
    : null;
  const horaire = schedule.startTime && schedule.endTime ? `${schedule.startTime}–${schedule.endTime}` : null;
  const interval = schedule.intervalMinutes && schedule.intervalMinutes > 0 ? `toutes les ${schedule.intervalMinutes} min` : null;
  if (schedule.runAtMs) return `Ponctuelle · ${formatDateFr(schedule.runAtMs)}`;
  return [jours, horaire, interval].filter(Boolean).join(" · ") || "Déclencheurs avancés (webhook / veille)";
};

export function AutomationsConsole() {
  const sessionDisponible = useSessionAvailable();

  const [tab, setTab] = useState<TabId>("agents");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulaire agent
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");

  // Formulaire planification
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [schedName, setSchedName] = useState("");
  const [schedAgent, setSchedAgent] = useState("");
  const [schedObjective, setSchedObjective] = useState("");
  const [schedMode, setSchedMode] = useState<"recurrent" | "ponctuel">("recurrent");
  const [schedDays, setSchedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [schedStart, setSchedStart] = useState("08:00");
  const [schedEnd, setSchedEnd] = useState("18:00");
  const [schedInterval, setSchedInterval] = useState(60);
  const [schedRunAt, setSchedRunAt] = useState("");
  const [schedTimezone, setSchedTimezone] = useState("Africa/Douala");

  // Historique
  const [runsOf, setRunsOf] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsBusy, setRunsBusy] = useState(false);

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) setSchedTimezone(tz);
  }, []);

  // Liens profonds (#planifications depuis la page d'accueil) : ouvrent
  // directement l'onglet demandé.
  useEffect(() => {
    const appliquer = () => {
      const hash = window.location.hash.replace("#", "") as TabId;
      if (TABS.some((item) => item.id === hash)) setTab(hash);
    };
    appliquer();
    window.addEventListener("hashchange", appliquer);
    return () => window.removeEventListener("hashchange", appliquer);
  }, []);

  const chargerTout = useCallback(async () => {
    setLoadError(null);
    try {
      const [a, s] = await Promise.all([
        authFetch("/api/agents", { cache: "no-store" }),
        authFetch("/api/agents/schedules", { cache: "no-store" }),
      ]);
      if (a.ok) {
        const data = await readJsonSafely<{ agents?: AgentSummary[] }>(a);
        setAgents(data?.agents ?? []);
      } else if (a.status !== 401) {
        setLoadError("Impossible de charger vos agents.");
      }
      if (s.ok) {
        const data = await readJsonSafely<{ schedules?: AgentSchedule[] }>(s);
        setSchedules(data?.schedules ?? []);
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void chargerTout();
  }, [sessionDisponible, chargerTout]);

  const creerAgent = async () => {
    if (agentName.trim().length < 2) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: agentName.trim(),
          description: agentDescription.trim() || `Agent Gen3ia dédié : ${agentName.trim()}.`,
          type: "universal",
          status: "active",
        }),
      });
      const data = await readJsonSafely<{ agent?: AgentSummary; error?: string }>(response);
      if (!response.ok || !data?.agent) {
        throw new Error(data?.error ?? `La création a échoué (erreur ${response.status}).`);
      }
      setAgents((prev) => [data.agent!, ...prev]);
      setSchedAgent(data.agent.id);
      setAgentName("");
      setAgentDescription("");
      setAgentFormOpen(false);
      setNotice(`Agent « ${data.agent.name} » créé — il est prêt à recevoir une planification.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La création de l'agent a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const creerPlanification = async () => {
    if (!schedName.trim() || !schedAgent || schedObjective.trim().length < 3) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const base: Record<string, unknown> = {
        name: schedName.trim(),
        agentId: schedAgent,
        objective: schedObjective.trim(),
        timezone: schedTimezone,
        enabled: true,
      };
      if (schedMode === "recurrent") {
        base.daysOfWeek = schedDays.length > 0 ? schedDays : [0, 1, 2, 3, 4, 5, 6];
        base.startTime = schedStart;
        base.endTime = schedEnd;
        base.intervalMinutes = Math.max(0, Math.min(1440, schedInterval));
      } else {
        const ts = schedRunAt ? new Date(schedRunAt).getTime() : 0;
        if (!Number.isFinite(ts) || ts <= Date.now()) {
          throw new Error("Choisissez une date et une heure FUTURES pour l'exécution ponctuelle.");
        }
        base.runAtMs = ts;
      }
      const response = await authFetch("/api/agents/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base),
      });
      const data = await readJsonSafely<{ schedule?: AgentSchedule; error?: string }>(response);
      if (!response.ok || !data?.schedule) {
        throw new Error(data?.error ?? `La création a échoué (erreur ${response.status}).`);
      }
      setSchedules((prev) => [data.schedule!, ...prev]);
      setSchedName("");
      setSchedObjective("");
      setScheduleFormOpen(false);
      setNotice("Planification créée : l'agent s'exécutera dans la fenêtre définie (serveur, 24h/24).");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La création de la planification a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const basculerPlanification = async (schedule: AgentSchedule) => {
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/agents/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      const data = await readJsonSafely<{ schedule?: AgentSchedule; error?: string }>(response);
      if (!response.ok || !data?.schedule) throw new Error(data?.error ?? "La mise à jour a échoué.");
      setSchedules((prev) => prev.map((item) => (item.id === schedule.id ? data.schedule! : item)));
      setNotice(data.schedule.enabled ? "Planification activée." : "Planification suspendue : elle ne se déclenchera plus jusqu'à réactivation.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La mise à jour a échoué.");
    }
  };

  const supprimerPlanification = async (scheduleId: string) => {
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/agents/schedules/${scheduleId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await readJsonSafely<{ error?: string }>(response);
        throw new Error(data?.error ?? "La suppression a échoué.");
      }
      setSchedules((prev) => prev.filter((item) => item.id !== scheduleId));
      if (runsOf === scheduleId) { setRunsOf(null); setRuns([]); }
      setNotice("Planification supprimée.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La suppression a échoué.");
    }
  };

  const declencherMaintenant = async (scheduleId: string) => {
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/agents/schedules/${scheduleId}/run`, { method: "POST" });
      const data = await readJsonSafely<{ executionId?: string; error?: string }>(response);
      if (!response.ok) throw new Error(data?.error ?? "Le déclenchement a échoué.");
      setNotice("Exécution lancée : suivez son statut dans l'historique (⟳).");
      void chargerTout();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Le déclenchement a échoué.");
    }
  };

  const voirRuns = async (scheduleId: string) => {
    setRunsBusy(true);
    setRunsOf(scheduleId);
    try {
      const response = await authFetch(`/api/agents/schedules/${scheduleId}/runs?limit=15`, { cache: "no-store" });
      const data = await readJsonSafely<{ runs?: ScheduleRun[]; error?: string }>(response);
      if (!response.ok) throw new Error(data?.error ?? "Historique indisponible.");
      setRuns(data?.runs ?? []);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Historique indisponible.");
      setRuns([]);
    } finally {
      setRunsBusy(false);
    }
  };

  const agentNom = (agentId: string): string => agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6">
      <SectionHeader
        eyebrow="GEN3IA · AUTOMATISATIONS"
        title="Espace"
        highlight="automatisations"
        description="Vos agents exécutent l'opérationnel pendant que vous avancez : créez un agent, planifiez ses tâches récurrentes, consultez chaque exécution. Les actions sensibles attendent toujours votre validation."
        action={
          tab === "agents" ? (
            <button
              type="button"
              onClick={() => { setAgentFormOpen((open) => !open); setScheduleFormOpen(false); }}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_var(--g3-primary)] transition hover:brightness-110"
            >
              <span aria-hidden="true">{agentFormOpen ? "×" : "+"}</span>
              {agentFormOpen ? "Fermer" : "Nouvel agent"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setScheduleFormOpen((open) => !open); setAgentFormOpen(false); }}
              disabled={agents.length === 0}
              title={agents.length === 0 ? "Créez d'abord un agent" : undefined}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_var(--g3-primary)] transition enabled:hover:brightness-110 disabled:opacity-50"
            >
              <span aria-hidden="true">{scheduleFormOpen ? "×" : "+"}</span>
              {scheduleFormOpen ? "Fermer" : "Nouvelle planification"}
            </button>
          )
        }
      />

      {notice && (
        <p className="mb-4 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <div className="mb-4 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {actionError}
          <button type="button" onClick={() => void chargerTout()} className="ml-3 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {/* Onglets */}
      <div className="mb-5 flex gap-1.5 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-1.5" role="tablist" aria-label="Sections des automatisations">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`min-h-11 flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${tab === item.id ? "bg-[var(--g3-elevated)] text-[var(--g3-text)] shadow-sm" : "text-[var(--g3-muted)] hover:text-[var(--g3-text)]"}`}
          >
            {item.label}
            <span className="ml-2 text-xs text-[var(--g3-faint)]">
              {item.id === "agents" ? agents.length : schedules.length}
            </span>
          </button>
        ))}
      </div>

      {sessionDisponible === false ? (
        <EmptyState
          icon="◷"
          title="Connectez-vous pour automatiser"
          description="Vos agents et planifications restent rattachés à votre compte : ils tournent sur les serveurs Gen3ia, 24h/24."
          action={
            <a href="/login" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Se connecter
            </a>
          }
        />
      ) : !loaded ? (
        <LoadingState label="Chargement des automatisations…" rows={3} />
      ) : loadError && agents.length === 0 ? (
        <EmptyState
          icon="⚠"
          title="Automatisations indisponibles"
          description={loadError}
          action={
            <button type="button" onClick={() => void chargerTout()} className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-5 py-2.5 text-sm font-semibold">
              Réessayer
            </button>
          }
        />
      ) : tab === "agents" ? (
        <AgentsTab
          agents={agents}
          formOpen={agentFormOpen}
          name={agentName}
          description={agentDescription}
          busy={busy}
          onName={setAgentName}
          onDescription={setAgentDescription}
          onSubmit={() => void creerAgent()}
          onToggleForm={() => setAgentFormOpen(false)}
        />
      ) : (
        <PlanificationsTab
          schedules={schedules}
          agents={agents}
          formOpen={scheduleFormOpen}
          busy={busy}
          runsOf={runsOf}
          runs={runs}
          runsBusy={runsBusy}
          form={{ schedName, schedAgent, schedObjective, schedMode, schedDays, schedStart, schedEnd, schedInterval, schedRunAt, schedTimezone }}
          setForm={{ setSchedName, setSchedAgent, setSchedObjective, setSchedMode, setSchedDays, setSchedStart, setSchedEnd, setSchedInterval, setSchedRunAt }}
          onSubmit={() => void creerPlanification()}
          onToggle={(schedule) => void basculerPlanification(schedule)}
          onDelete={(id) => void supprimerPlanification(id)}
          onRun={(id) => void declencherMaintenant(id)}
          onRuns={(id) => void voirRuns(id)}
          agentNom={agentNom}
          descriptionFenetre={descriptionFenetre}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Agents                                                       */
/* ------------------------------------------------------------------ */

function AgentsTab({
  agents,
  formOpen,
  name,
  description,
  busy,
  onName,
  onDescription,
  onSubmit,
}: {
  agents: AgentSummary[];
  formOpen: boolean;
  name: string;
  description: string;
  busy: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onSubmit: () => void;
  onToggleForm: () => void;
}) {
  return (
    <div className="space-y-5">
      {formOpen && (
        <form
          className="grid gap-4 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 sm:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        >
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Nom de l&apos;agent
            <input
              value={name}
              onChange={(event) => onName(event.target.value)}
              required
              minLength={2}
              maxLength={80}
              placeholder="ex. Veille concurrentielle"
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            />
          </label>
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Mission (facultatif)
            <input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              maxLength={500}
              placeholder="ex. Surveiller les prix et nouveautés du secteur"
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy || name.trim().length < 2}
              className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Création…" : "Créer l'agent"}
            </button>
          </div>
        </form>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon="◷"
          title="Aucun agent"
          description="Créez votre premier agent : donnez-lui un nom et une mission, puis planifiez ses tâches dans l'onglet Planifications. Vous pouvez aussi tout demander en langage naturel depuis le Chat IA."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <li key={agent.id} className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[var(--g3-text)]">{agent.name}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--g3-muted)]">{agent.description || "Sans mission décrite."}</p>
                </div>
                <Badge
                  label={agent.status === "active" ? "Actif" : agent.status === "paused" ? "En pause" : agent.status}
                  className={agent.status === "active" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : undefined}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--g3-faint)]">
                <Badge label={agent.typeLabel || agent.type} />
                {agent.autonomous && <Badge label="Autonome" className="bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]" />}
                <span>{agent.tools?.length ?? 0} outil(s)</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Planifications                                               */
/* ------------------------------------------------------------------ */

function PlanificationsTab({
  schedules,
  agents,
  formOpen,
  busy,
  runsOf,
  runs,
  runsBusy,
  form,
  setForm,
  onSubmit,
  onToggle,
  onDelete,
  onRun,
  onRuns,
  agentNom,
  descriptionFenetre,
}: {
  schedules: AgentSchedule[];
  agents: AgentSummary[];
  formOpen: boolean;
  busy: boolean;
  runsOf: string | null;
  runs: ScheduleRun[];
  runsBusy: boolean;
  form: {
    schedName: string;
    schedAgent: string;
    schedObjective: string;
    schedMode: "recurrent" | "ponctuel";
    schedDays: number[];
    schedStart: string;
    schedEnd: string;
    schedInterval: number;
    schedRunAt: string;
    schedTimezone: string;
  };
  setForm: {
    setSchedName: (v: string) => void;
    setSchedAgent: (v: string) => void;
    setSchedObjective: (v: string) => void;
    setSchedMode: (v: "recurrent" | "ponctuel") => void;
    setSchedDays: (v: number[]) => void;
    setSchedStart: (v: string) => void;
    setSchedEnd: (v: string) => void;
    setSchedInterval: (v: number) => void;
    setSchedRunAt: (v: string) => void;
  };
  onSubmit: () => void;
  onToggle: (schedule: AgentSchedule) => void;
  onDelete: (scheduleId: string) => void;
  onRun: (scheduleId: string) => void;
  onRuns: (scheduleId: string) => void;
  agentNom: (agentId: string) => string;
  descriptionFenetre: (schedule: AgentSchedule) => string;
}) {
  const inputClass = "mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]";
  return (
    <div className="space-y-5">
      {formOpen && (
        <form
          className="grid gap-4 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 sm:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        >
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Nom de la tâche
            <input
              value={form.schedName}
              onChange={(event) => setForm.setSchedName(event.target.value)}
              required
              minLength={1}
              maxLength={200}
              placeholder="ex. Rapport quotidien de veille"
              className={inputClass}
            />
          </label>
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Agent d&apos;exécution
            <select
              value={form.schedAgent}
              onChange={(event) => setForm.setSchedAgent(event.target.value)}
              required
              className={inputClass}
            >
              <option value="">— Choisir un agent —</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-[var(--g3-text-secondary)] sm:col-span-2">
            Objectif (ce que l&apos;agent doit faire à chaque déclenchement)
            <textarea
              value={form.schedObjective}
              onChange={(event) => setForm.setSchedObjective(event.target.value)}
              required
              minLength={3}
              rows={2}
              maxLength={50_000}
              placeholder="ex. Parcours les actualités du secteur et prépare un résumé structuré des mouvements concurrentiels."
              className={`${inputClass} resize-y`}
            />
          </label>

          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium text-[var(--g3-text-secondary)]">Récurrence</legend>
            <div className="mt-2 flex gap-2">
              {(["recurrent", "ponctuel"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setForm.setSchedMode(mode)}
                  aria-pressed={form.schedMode === mode}
                  className={`min-h-11 flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${form.schedMode === mode ? "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]" : "border border-[var(--g3-border)] text-[var(--g3-muted)]"}`}
                >
                  {mode === "recurrent" ? "Récurrente (fenêtre quotidienne)" : "Ponctuelle (une fois)"}
                </button>
              ))}
            </div>
          </fieldset>

          {form.schedMode === "recurrent" ? (
            <>
              <div className="sm:col-span-2">
                <span className="text-sm font-medium text-[var(--g3-text-secondary)]">Jours</span>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {DAYS.map((day) => {
                    const active = form.schedDays.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setForm.setSchedDays(active ? form.schedDays.filter((d) => d !== day.value) : [...form.schedDays, day.value])
                        }
                        className={`h-11 w-11 rounded-xl text-sm font-semibold transition ${active ? "bg-[var(--g3-primary)] text-white" : "border border-[var(--g3-border)] text-[var(--g3-muted)]"}`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Début de fenêtre
                <input type="time" value={form.schedStart} onChange={(event) => setForm.setSchedStart(event.target.value)} className={inputClass} />
              </label>
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Fin de fenêtre
                <input type="time" value={form.schedEnd} onChange={(event) => setForm.setSchedEnd(event.target.value)} className={inputClass} />
              </label>
              <label className="text-sm font-medium text-[var(--g3-text-secondary)] sm:col-span-2">
                Intervalle entre exécutions (minutes — 0 = une fois par fenêtre)
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={form.schedInterval}
                  onChange={(event) => setForm.setSchedInterval(Number(event.target.value))}
                  className={inputClass}
                />
              </label>
            </>
          ) : (
            <label className="text-sm font-medium text-[var(--g3-text-secondary)] sm:col-span-2">
              Date et heure d&apos;exécution (futures)
              <input
                type="datetime-local"
                value={form.schedRunAt}
                onChange={(event) => setForm.setSchedRunAt(event.target.value)}
                className={inputClass}
              />
            </label>
          )}

          <p className="text-xs text-[var(--g3-faint)] sm:col-span-2">
            Fuseau appliqué : {form.schedTimezone} — détecté de votre appareil. Les fenêtres s&apos;expriment dans ce fuseau.
          </p>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy || !form.schedName.trim() || !form.schedAgent || form.schedObjective.trim().length < 3}
              className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Création…" : "Créer la planification"}
            </button>
          </div>
        </form>
      )}

      {schedules.length === 0 ? (
        <EmptyState
          icon="◷"
          title="Aucune planification"
          description="Créez une tâche récurrente (veille, rapport, relance) rattachée à un agent — elle s'exécutera sur les serveurs Gen3ia même application fermée. Vous pouvez aussi la demander en langage naturel au Chat IA."
        />
      ) : (
        <ul className="space-y-3">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-[var(--g3-text)]">{schedule.name}</p>
                    <Badge
                      label={schedule.enabled ? "Active" : "Suspendue"}
                      className={schedule.enabled ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : "bg-[var(--g3-elevated)] text-[var(--g3-faint)]"}
                    />
                    {schedule.lastExecutionStatus && (
                      <Badge
                        label={`Dernière : ${schedule.lastExecutionStatus}`}
                        className={RUN_STATUS_CLASS[schedule.lastExecutionStatus] ?? undefined}
                      />
                    )}
                  </div>
                  <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
                    Agent <span className="font-medium text-[var(--g3-text)]">{agentNom(schedule.agentId)}</span> · {descriptionFenetre(schedule)}
                  </p>
                  {schedule.objective && (
                    <p className="mt-1.5 line-clamp-2 text-sm text-[var(--g3-muted)]">{schedule.objective}</p>
                  )}
                  <p className="mt-1.5 text-xs text-[var(--g3-faint)]">
                    Prochaine : {formatDateFr(schedule.nextRunAt)}
                    {schedule.lastExecutionAt ? ` · dernière exécution ${formatDateFr(schedule.lastExecutionAt)}` : ""}
                  </p>
                  {schedule.lastError && (
                    <p className="mt-1.5 text-xs text-[var(--g3-danger-strong)]" role="alert">Dernière erreur : {schedule.lastError}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onRun(schedule.id)}
                    className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary-soft)] px-4 py-2 text-xs font-semibold text-[var(--g3-primary-strong)] transition hover:brightness-105"
                  >
                    Exécuter maintenant
                  </button>
                  <button
                    type="button"
                    onClick={() => onRuns(schedule.id)}
                    aria-expanded={runsOf === schedule.id}
                    className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-4 py-2 text-xs font-semibold transition hover:border-[var(--g3-primary-border)]"
                  >
                    Historique ⟳
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggle(schedule)}
                    className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-4 py-2 text-xs font-semibold transition hover:border-[var(--g3-primary-border)]"
                  >
                    {schedule.enabled ? "Suspendre" : "Activer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(schedule.id)}
                    className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-4 py-2 text-xs font-semibold transition hover:border-[var(--g3-danger-strong)] hover:text-[var(--g3-danger-strong)]"
                  >
                    Supprimer
                  </button>
                </div>
              </div>

              {runsOf === schedule.id && (
                <div className="mt-4 border-t border-[var(--g3-border)] pt-4">
                  {runsBusy ? (
                    <LoadingState label="Chargement de l'historique…" rows={1} />
                  ) : runs.length === 0 ? (
                    <p className="text-sm text-[var(--g3-muted)]">Aucune exécution enregistrée : la tâche n&apos;a pas encore été déclenchée.</p>
                  ) : (
                    <ul className="space-y-2">
                      {runs.map((run) => (
                        <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--g3-elevated)] px-3.5 py-2 text-sm">
                          <span className="flex items-center gap-2">
                            <Badge
                              label={run.status}
                              className={RUN_STATUS_CLASS[run.status] ?? undefined}
                            />
                            <span className="text-xs text-[var(--g3-muted)]">{formatDateFr(run.startedAt ?? run.slot)}</span>
                          </span>
                          {run.error && <span className="max-w-md truncate text-xs text-[var(--g3-danger-strong)]">{run.error}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
