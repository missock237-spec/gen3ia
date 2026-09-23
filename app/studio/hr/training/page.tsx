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

/** Module RH — Formations (Data Engine + Workflow Engine à l'achèvement). */

interface Training {
  id: string;
  title: string;
  employeeName: string;
  category: string;
  provider?: string;
  durationHours: number;
  dueAt?: string;
  description?: string;
  status: string;
  progress: number;
}

interface TrainingKpis {
  total: number;
  completed: number;
  inProgress: number;
  totalHours: number;
}

const CATEGORIES: Record<string, string> = {
  onboarding: "Intégration",
  product: "Produit",
  compliance: "Conformité",
  technical: "Technique",
  soft_skills: "Compétences douces",
  management: "Management",
  other: "Autre",
};

export default function HrTrainingPage() {
  const { items: trainings, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Training>("/api/business/hr-training", "trainings");
  const kpis = (extra.kpis as TrainingKpis | undefined) ?? { total: 0, completed: 0, inProgress: 0, totalHours: 0 };
  const [form, setForm] = useState({ title: "", employeeName: "", category: "other", provider: "", durationHours: "2", dueAt: "" });
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    if (await mutate("POST", { title: form.title, employeeName: form.employeeName, category: form.category, ...(form.provider ? { provider: form.provider } : {}), durationHours: Number(form.durationHours) || 2, ...(form.dueAt ? { dueAt: form.dueAt } : {}) })) {
      setNotice("Formation ajoutée au plan.");
      setForm({ ...form, title: "", employeeName: "", provider: "", dueAt: "" });
    }
  }

  async function setProgress(id: string, progress: number) {
    setNotice(null);
    const result = await mutate("PATCH", { id, progress });
    if (result) setNotice(progress >= 100 ? "Formation terminée — les automatisations ont été notifiées." : `Progression mise à jour (${progress} %).`);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · RH"
        title="Formations"
        description="Plan de formation par employé avec progression suivie : l'achèvement déclenche automatiquement vos automatisations (attestation, suivi…)."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <StatCard label="Formations" value={String(kpis.total)} />
        <StatCard label="Terminées" value={String(kpis.completed)} tone="green" />
        <StatCard label="En cours" value={String(kpis.inProgress)} tone="amber" />
        <StatCard label="Heures planifiées" value={`${kpis.totalHours} h`} />
      </div>

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Ajouter une formation</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Intitulé">
            <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Maîtrise du CRM" />
          </Field>
          <Field label="Employé">
            <input className={inputCls} value={form.employeeName} onChange={(e) => setForm({ ...form, employeeName: e.target.value })} placeholder="Marie Dupont" />
          </Field>
          <Field label="Catégorie">
            <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {Object.entries(CATEGORIES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </Field>
          <Field label="Organisme (optionnel)">
            <input className={inputCls} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="Interne / OpenClassrooms…" />
          </Field>
          <Field label="Durée (heures)">
            <input type="number" min="0.5" step="0.5" className={inputCls} value={form.durationHours} onChange={(e) => setForm({ ...form, durationHours: e.target.value })} />
          </Field>
          <Field label="Échéance (optionnel)">
            <input type="date" className={inputCls} value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.title || !form.employeeName} onClick={create}>
            Ajouter
          </button>
        </div>
      </div>

      <ModuleSection title={`Plan de formation (${trainings.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && trainings.length === 0 ? <EmptyHint>Aucune formation pour l&apos;instant.</EmptyHint> : null}
        <div className="space-y-2.5">
          {trainings.map((training) => (
            <article key={training.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-bold text-neutral-900">{training.title}</h3>
                  <p className="text-[12.5px] text-neutral-500">
                    {training.employeeName} · {CATEGORIES[training.category] ?? training.category} · {training.durationHours} h
                    {training.dueAt ? ` · échéance ${shortDate(training.dueAt)}` : ""}{training.provider ? ` · ${training.provider}` : ""}
                  </p>
                </div>
                <Pill tone={statusTone(training.status)}>{statusLabel(training.status)}</Pill>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
                  <div className={`h-full rounded-full ${training.progress >= 100 ? "bg-emerald-500" : "bg-neutral-900"}`} style={{ width: `${training.progress}%` }} />
                </div>
                <span className="w-12 text-right text-[12.5px] font-bold text-neutral-700">{training.progress} %</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button className={btnGhostCls} disabled={busy || training.progress >= 100} onClick={() => setProgress(training.id, Math.min(100, training.progress + 25))}>
                  +25 %
                </button>
                <button className={btnGhostCls} disabled={busy || training.progress >= 100} onClick={() => setProgress(training.id, 100)}>
                  Terminer
                </button>
                <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(training.id)}>
                  Supprimer
                </button>
              </div>
            </article>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
