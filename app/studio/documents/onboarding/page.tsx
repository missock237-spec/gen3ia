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
} from "@/components/business/kit";

/** Module Documents — Onboarding (templates par rôle + Workflow Engine). */

interface FlowStep {
  title: string;
  dueInDays: number;
  done: boolean;
}

interface Flow {
  id: string;
  name: string;
  role: string;
  targetName: string;
  steps: FlowStep[];
  status: string;
}

interface FlowKpis {
  total: number;
  active: number;
  completed: number;
}

const ROLE_LABELS: Record<string, string> = { employee: "Nouvel employé", client: "Nouveau client", contractor: "Prestataire" };

export default function DocumentsOnboardingPage() {
  const { items: flows, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Flow>("/api/business/documents-onboarding", "flows");
  const kpis = (extra.kpis as FlowKpis | undefined) ?? { total: 0, active: 0, completed: 0 };
  const [form, setForm] = useState({ name: "", role: "employee", targetName: "" });
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    if (await mutate("POST", form)) {
      setNotice("Parcours créé avec son modèle d'étapes.");
      setForm({ ...form, name: "", targetName: "" });
    }
  }

  async function toggleStep(flow: Flow, stepIndex: number) {
    setNotice(null);
    const result = await mutate("PATCH", { id: flow.id, stepIndex });
    if (result) {
      const updated = (result.flow as Flow | undefined) ?? null;
      setNotice(updated?.status === "completed" ? "Parcours complété — automatisations notifiées." : "Étape mise à jour.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · DOCUMENTS"
        title="Onboarding"
        description="Parcours d'intégration prêts à l'emploi pour employés, clients et prestataires : étapes ordonnées avec échéances, cochage progressif et complétion suivie."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Parcours" value={String(kpis.total)} />
        <StatCard label="Actifs" value={String(kpis.active)} tone="amber" />
        <StatCard label="Complétés" value={String(kpis.completed)} tone="green" />
      </div>

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Nouveau parcours</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Nom du parcours">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Arrivée septembre 2026" />
          </Field>
          <Field label="Rôle">
            <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {Object.entries(ROLE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </Field>
          <Field label="Personne / société concernée">
            <input className={inputCls} value={form.targetName} onChange={(e) => setForm({ ...form, targetName: e.target.value })} placeholder="Marie Dupont" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.name || !form.targetName} onClick={create}>
            Créer le parcours
          </button>
        </div>
      </div>

      <ModuleSection title={`Parcours (${flows.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && flows.length === 0 ? <EmptyHint>Aucun parcours pour l'instant.</EmptyHint> : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {flows.map((flow) => {
            const done = flow.steps?.filter((s) => s.done).length ?? 0;
            const total = flow.steps?.length ?? 0;
            return (
              <article key={flow.id} className={cardCls}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[14px] font-bold text-neutral-900">{flow.name}</h3>
                    <p className="text-[12.5px] text-neutral-500">
                      {flow.targetName} · {ROLE_LABELS[flow.role] ?? flow.role} · {done}/{total} étapes
                    </p>
                  </div>
                  <Pill tone={statusTone(flow.status)}>{statusLabel(flow.status)}</Pill>
                </div>

                <ul className="mt-3 space-y-1.5">
                  {(flow.steps ?? []).map((step, index) => (
                    <li key={index}>
                      <button
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition ${step.done ? "bg-emerald-50 text-emerald-800" : "bg-neutral-50 text-neutral-700 hover:bg-neutral-100"}`}
                        onClick={() => toggleStep(flow, index)}
                        disabled={busy}
                      >
                        <span className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${step.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-neutral-300 bg-white text-neutral-400"}`}>
                          {step.done ? "✓" : index + 1}
                        </span>
                        <span className="flex-1">{step.title}</span>
                        <span className="text-[11px] text-neutral-400">J+{step.dueInDays}</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mt-3 flex justify-end">
                  <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(flow.id)}>
                    Supprimer
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </ModuleSection>
    </main>
  );
}
