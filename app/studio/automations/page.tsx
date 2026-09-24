"use client";

import { useState } from "react";
import { StudioHeader } from "@/components/studio/studio-header";
import {
  Field,
  Pill,
  EmptyHint,
  ModuleSection,
  StatCard,
  inputCls,
  btnPrimaryCls,
  btnGhostCls,
  cardCls,
  useModuleData,
  statusTone,
  statusLabel,
  shortDate,
} from "@/components/business/kit";

/** Module ⚡ Automatisations — hub du Workflow Engine. */

const EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "hr.leave_requested", label: "RH : demande de congé créée" },
  { value: "hr.leave_decided", label: "RH : congé approuvé/refusé" },
  { value: "hr.training_completed", label: "RH : formation terminée" },
  { value: "sales.call_analyzed", label: "Ventes : appel analysé" },
  { value: "documents.contract_signed", label: "Documents : contrat signé" },
  { value: "documents.onboarding_completed", label: "Documents : onboarding complété" },
  { value: "gdpr.request_received", label: "Conformité : demande RGPD reçue" },
  { value: "operations.maintenance_recorded", label: "Opérations : maintenance réalisée" },
  { value: "finance.invoice_created", label: "Finance : facture créée" },
  { value: "finance.invoice_reminded", label: "Finance : relance envoyée" },
  { value: "finance.invoice_paid", label: "Finance : facture payée" },
  { value: "marketing.landing_published", label: "Marketing : landing publiée" },
  { value: "marketing.content_generated", label: "Marketing : contenu généré" },
  { value: "calendar.event_created", label: "Calendrier : événement créé" },
];

const STEP_TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: "ai_text", label: "Texte IA", hint: "prompt avec {{placeholders}}" },
  { value: "notification", label: "Notification", hint: "titre + message" },
  { value: "create_event", label: "Événement calendrier", hint: "startAt : ISO ou +Nd" },
  { value: "create_record", label: "Enregistrement", hint: "collection + données" },
  { value: "update_record", label: "Mise à jour d'enregistrement", hint: "collection + id + données" },
];

interface WorkflowStep {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

interface Workflow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { type: string; eventType?: string };
  conditions: Array<{ field: string; op: string; value: unknown }>;
  steps: WorkflowStep[];
  runCount: number;
  lastRunAt?: number;
}

interface Run {
  id: string;
  workflowName: string;
  trigger: string;
  status: string;
  steps: Array<{ stepId: string; name: string; type: string; status: string; output?: string; error?: string }>;
  startedAt: number;
}

interface Notification {
  id: string;
  title: string;
  body: string;
  workflowName?: string;
  createdAt: number;
}

export default function AutomationsPage() {
  const { items: workflows, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Workflow>("/api/business/automations", "workflows");
  const runs = (extra.runs as Run[] | undefined) ?? [];
  const notifications = (extra.notifications as Notification[] | undefined) ?? [];
  const [form, setForm] = useState({ name: "", description: "", triggerType: "event", eventType: "finance.invoice_created", stepType: "notification", stepName: "", prompt: "", title: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    const stepConfig =
      form.stepType === "notification"
        ? { title: form.title || "Automatisation", body: form.prompt || form.name }
        : { prompt: form.prompt, system: "Tu es l'assistant d'automatisation GEN3IA. Réponds en français, concis et utile." };
    const result = await mutate("POST", {
      action: "create",
      name: form.name,
      ...(form.description ? { description: form.description } : {}),
      trigger: { type: form.triggerType, ...(form.triggerType === "event" ? { eventType: form.eventType } : {}) },
      conditions: [],
      steps: [{ id: `step1`, name: form.stepName || form.name, type: form.stepType, config: stepConfig }],
    });
    if (result?.workflow) {
      setNotice("Automatisation créée et activée.");
      setForm({ ...form, name: "", description: "", stepName: "", prompt: "", title: "" });
    }
  }

  async function run(workflowId: string) {
    setNotice(null);
    const result = await mutate("POST", { action: "run", workflowId });
    if (result?.run) setNotice(`Exécution terminée : statut ${statusLabel(String((result.run as Run).status))}.`);
  }

  async function toggle(workflow: Workflow) {
    setNotice(null);
    if (await mutate("PATCH", { id: workflow.id, enabled: !workflow.enabled })) setNotice(workflow.enabled ? "Automatisation désactivée." : "Automatisation activée.");
  }

  const activeCount = workflows.filter((w) => w.enabled).length;
  const successRuns = runs.filter((r) => r.status === "success").length;

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · AUTOMATISATIONS"
        title="Automatisations"
        highlight="workflow"
        description="Créez des chaînes déclenchées par les événements des modules (RH, Ventes, Finance…) : conditions, étapes IA, notifications et écritures automatiques."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Automatisations" value={String(workflows.length)} hint={`${activeCount} active(s)`} />
        <StatCard label="Exécutions récentes" value={String(runs.length)} hint={`${successRuns} succès`} />
        <StatCard label="Notifications" value={String(notifications.length)} />
      </div>

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-[var(--g3-text)]">Nouvelle automatisation</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nom">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Alerter quand une facture est créée" />
          </Field>
          <Field label="Déclencheur">
            <select className={inputCls} value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })}>
              <option value="event">Événement métier</option>
              <option value="manual">Manuel (bouton Exécuter)</option>
            </select>
          </Field>
          {form.triggerType === "event" ? (
            <Field label="Événement écouté" hint="Les modules émettent ces événements automatiquement.">
              <select className={inputCls} value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>
                {EVENT_TYPES.map((event) => (
                  <option key={event.value} value={event.value}>{event.label}</option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Type d'étape">
            <select className={inputCls} value={form.stepType} onChange={(e) => setForm({ ...form, stepType: e.target.value })}>
              {STEP_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Nom de l'étape">
            <input className={inputCls} value={form.stepName} onChange={(e) => setForm({ ...form, stepName: e.target.value })} placeholder="Notifier l'équipe" />
          </Field>
          {form.stepType === "notification" ? (
            <Field label="Titre de la notification">
              <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Nouvelle facture à surveiller" />
            </Field>
          ) : null}
        </div>
        {form.stepType === "ai_text" || form.stepType === "notification" ? (
          <div className="mt-4">
            <Field label={form.stepType === "ai_text" ? "Prompt IA (placeholders : {{payload.champ}})" : "Message de la notification"}>
              <textarea className={inputCls} rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Rédige un résumé de la facture {{payload.invoiceNumber}} pour le client {{payload.clientName}}." />
            </Field>
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.name} onClick={create}>
            Créer l&apos;automatisation
          </button>
        </div>
      </div>

      <ModuleSection title={`Automatisations (${workflows.length})`}>
        {loading ? <p className="text-[13px] text-[var(--g3-muted)]">Chargement…</p> : null}
        {!loading && workflows.length === 0 ? <EmptyHint>Aucune automatisation pour l&apos;instant. Créez la première ci-dessus.</EmptyHint> : null}
        <div className="space-y-2.5">
          {workflows.map((workflow) => (
            <article key={workflow.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-bold text-[var(--g3-text)]">{workflow.name}</h3>
                  <p className="text-[12.5px] text-[var(--g3-muted)]">
                    {workflow.trigger.type === "event"
                      ? `Déclencheur : ${EVENT_TYPES.find((e) => e.value === workflow.trigger.eventType)?.label ?? workflow.trigger.eventType}`
                      : "Déclencheur : manuel"}{" "}
                    · {workflow.steps.length} étape(s) · {workflow.runCount} exécution(s){workflow.lastRunAt ? ` · dernière ${shortDate(workflow.lastRunAt)}` : ""}
                  </p>
                </div>
                <Pill tone={workflow.enabled ? "green" : "neutral"}>{workflow.enabled ? "Active" : "Inactive"}</Pill>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={btnPrimaryCls} disabled={busy || !workflow.enabled} onClick={() => run(workflow.id)}>
                  Exécuter maintenant
                </button>
                <button className={btnGhostCls} disabled={busy} onClick={() => toggle(workflow)}>
                  {workflow.enabled ? "Désactiver" : "Activer"}
                </button>
                <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(workflow.id)}>
                  Supprimer
                </button>
              </div>
            </article>
          ))}
        </div>
      </ModuleSection>

      <ModuleSection title="Notifications">
        {!loading && notifications.length === 0 ? <EmptyHint>Aucune notification générée par vos automatisations.</EmptyHint> : null}
        <div className="space-y-2">
          {notifications.map((notification) => (
            <div key={notification.id} className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3">
              <p className="text-[13px] font-bold text-[var(--g3-text)]">{notification.title}</p>
              <p className="text-[12.5px] text-[var(--g3-muted)]">{notification.body}</p>
              <p className="mt-1 text-[11px] text-[var(--g3-faint)]">
                {notification.workflowName ?? "Automatisation"} · {shortDate(notification.createdAt)}
              </p>
            </div>
          ))}
        </div>
      </ModuleSection>

      <ModuleSection title="Journal des exécutions">
        {!loading && runs.length === 0 ? <EmptyHint>Aucune exécution pour l&apos;instant.</EmptyHint> : null}
        <div className="space-y-2">
          {runs.map((run) => (
            <div key={run.id} className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] font-bold text-[var(--g3-text)]">{run.workflowName}</p>
                  <p className="text-[11.5px] text-[var(--g3-muted)]">
                    {run.trigger === "manual" ? "Manuel" : "Événement"} · {shortDate(run.startedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={statusTone(run.status)}>{statusLabel(run.status)}</Pill>
                  <button className={btnGhostCls} onClick={() => setOpenRun(openRun === run.id ? null : run.id)}>
                    {openRun === run.id ? "Masquer" : "Détails"}
                  </button>
                </div>
              </div>
              {openRun === run.id ? (
                <ol className="mt-2 space-y-1 text-[12.5px]">
                  {run.steps.map((step, i) => (
                    <li key={step.stepId + i} className="rounded-lg bg-[var(--g3-elevated)] px-3 py-1.5">
                      <Pill tone={step.status === "success" ? "green" : "red"}>{step.status === "success" ? "OK" : "Échec"}</Pill>{" "}
                      <strong>{step.name}</strong> — {step.output ?? step.error}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
