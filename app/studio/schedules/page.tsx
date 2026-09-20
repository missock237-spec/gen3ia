"use client";

import { useEffect, useState } from "react";

import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

import { Callout } from "@/components/studio/callout";
import { EmptyState } from "@/components/studio/empty-state";
import { ScheduleForm } from "@/components/studio/schedule-form";
import { ScheduleCard } from "@/components/studio/schedule-card";
import { ScheduleCardSkeleton } from "@/components/studio/skeletons";
import { StudioHeader } from "@/components/studio/studio-header";
import { type Agent, type Schedule, type ScheduleDraft, type ScheduleRun } from "@/components/studio/schedule-types";

/**
 * Planification des agents (/studio/schedules).
 * Structure entreprise :
 *  - logique API concentrée ici ; présentation déléguée à ScheduleForm /
 *    ScheduleCard / Callout / EmptyState / skeletons ;
 *  - en-tête et navigation de section factorisés (StudioHeader + layout).
 */
export default function AgentSchedulesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");
  const [history, setHistory] = useState<Record<string, ScheduleRun[]>>({});

  const sessionDisponible = useSessionAvailable();

  const notify = (text: string, tone: "info" | "error" = "info") => {
    setMessage(text);
    setMessageTone(tone);
  };

  const load = async () => {
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
    const unsubscribe = watchAuth(async (current) => {
      setUser(current);
      try {
        await load();
      } catch (error) {
        notify(error instanceof Error ? error.message : "Chargement impossible", "error");
      } finally {
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  const create = async (draft: ScheduleDraft) => {
    if (sessionDisponible === false) { notify("Session expirée. Reconnectez-vous.", "error"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await authFetch("/api/agents/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, enabled: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Création impossible");
      setSchedules((current) => [data.schedule, ...current]);
      notify("Planification enregistrée.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Création impossible", "error");
    } finally {
      setBusy(false);
    }
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
    } catch (error) {
      notify(error instanceof Error ? error.message : "Modification impossible", "error");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (schedule: Schedule) => {
    if (sessionDisponible === false) return;
    setBusy(true); setMessage("");
    try {
      const response = await authFetch(`/api/agents/schedules/${encodeURIComponent(schedule.id)}/run`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Exécution impossible");
      setSchedules((current) => current.map((item) => item.id === schedule.id ? { ...item, lastExecutionStatus: data.status ?? "running", lastExecutionAt: new Date().toISOString() } : item));
      notify("Exécution manuelle lancée.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Exécution impossible", "error");
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = async (schedule: Schedule) => {
    try {
      const response = await authFetch(`/api/agents/schedules/${encodeURIComponent(schedule.id)}/runs?limit=10`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).error ?? "Historique indisponible");
      const data = await response.json();
      setHistory((current) => ({ ...current, [schedule.id]: data.runs ?? [] }));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Historique indisponible", "error");
    }
  };

  const remove = async (schedule: Schedule) => {
    if (sessionDisponible === false || !window.confirm(`Supprimer « ${schedule.name} » ?`)) return;
    setBusy(true); setMessage("");
    try {
      const response = await authFetch(`/api/agents/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error ?? "Suppression impossible");
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
      notify("Planification supprimée.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Suppression impossible", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-4">
      <StudioHeader
        eyebrow="GEN3IA · AUTOMATION"
        title="Planification des agents"
        description="Définissez les jours et la fenêtre horaire pendant lesquels un agent peut être activé automatiquement. Le serveur applique la fenêtre et le fuseau horaire, même si l'utilisateur ferme l'application."
      />

      {message && <Callout tone={messageTone === "error" ? "error" : "info"} className="mb-5">{message}</Callout>}

      <section className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <ScheduleForm agents={agents} busy={busy} userReady={Boolean(user)} onCreate={create} />

        <div className="g3-card p-6">
          <h2 className="font-serif text-xl font-semibold">Vos planifications</h2>
          <p className="mt-2 text-sm text-neutral-500">La planification est stockée dans Firestore et traitée côté serveur.</p>

          <div className="mt-5 space-y-3">
            {loading ? (
              <>
                <ScheduleCardSkeleton />
                <ScheduleCardSkeleton />
              </>
            ) : schedules.length === 0 ? (
              <EmptyState
                tone="sky"
                icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>}
                title="Aucune planification"
                description="Créez votre première planification : choisissez un agent actif, définissez les jours et la fenêtre horaire d'exécution."
              />
            ) : (
              schedules.map((schedule) => (
                <ScheduleCard
                  key={schedule.id}
                  schedule={schedule}
                  busy={busy}
                  history={history[schedule.id]}
                  onRun={(item) => void runNow(item)}
                  onToggle={(item) => void toggle(item)}
                  onRemove={(item) => void remove(item)}
                  onLoadHistory={(item) => void loadHistory(item)}
                />
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
