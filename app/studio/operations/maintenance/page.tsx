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

/** Module Opérations — Maintenance préventive (Scheduling Engine + preuves PDF). */

interface Asset {
  id: string;
  name: string;
  location?: string;
  intervalDays: number;
  lastDoneAt?: string;
  nextDueAt?: string;
  status: string;
  daysUntilDue: number | null;
  maintenanceCount: number;
}

interface AssetKpis {
  total: number;
  overdue: number;
  dueSoon: number;
}

const STATUS_TONE: Record<string, "green" | "amber" | "red"> = { ok: "green", due_soon: "amber", overdue: "red" };

export default function OperationsMaintenancePage() {
  const { items: assets, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Asset>("/api/business/operations-maintenance", "assets");
  const kpis = (extra.kpis as AssetKpis | undefined) ?? { total: 0, overdue: 0, dueSoon: 0 };
  const [form, setForm] = useState({ name: "", location: "", intervalDays: "90", lastDoneAt: "", notes: "" });
  const [record, setRecord] = useState({ technician: "", cost: "", notes: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    if (await mutate("POST", {
      action: "create",
      name: form.name,
      ...(form.location ? { location: form.location } : {}),
      intervalDays: Number(form.intervalDays) || 90,
      ...(form.lastDoneAt ? { lastDoneAt: form.lastDoneAt } : {}),
      ...(form.notes ? { notes: form.notes } : {}),
    })) {
      setNotice("Actif créé — rappel planifié 3 jours avant l'échéance.");
      setForm({ ...form, name: "", location: "", lastDoneAt: "", notes: "" });
    }
  }

  async function recordIntervention(assetId: string) {
    setNotice(null);
    if (await mutate("POST", {
      action: "record",
      assetId,
      ...(record.technician ? { technician: record.technician } : {}),
      ...(record.cost ? { cost: Number(record.cost) } : {}),
      ...(record.notes ? { notes: record.notes } : {}),
    })) {
      setNotice("Intervention enregistrée — preuve PDF horodatée générée, échéance replanifiée.");
      setRecordingId(null);
      setRecord({ technician: "", cost: "", notes: "" });
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · OPÉRATIONS"
        title="Maintenance"
        description="Actifs avec plan préventif : échéances calculées, rappels au calendrier, interventions horodatées avec preuve PDF et replanification automatique."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Actifs suivis" value={String(kpis.total)} />
        <StatCard label="Échéance proche (7 j)" value={String(kpis.dueSoon)} tone={kpis.dueSoon ? "amber" : "green"} />
        <StatCard label="En retard" value={String(kpis.overdue)} tone={kpis.overdue ? "red" : "green"} />
      </div>

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Nouvel actif à maintenir</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nom de l'actif">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Climatiseur bureau 2" />
          </Field>
          <Field label="Localisation (optionnel)">
            <input className={inputCls} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Siège — 2e étage" />
          </Field>
          <Field label="Intervalle de maintenance (jours)">
            <input type="number" min="1" className={inputCls} value={form.intervalDays} onChange={(e) => setForm({ ...form, intervalDays: e.target.value })} />
          </Field>
          <Field label="Dernière intervention (optionnel)" hint="Par défaut : aujourd'hui.">
            <input type="date" className={inputCls} value={form.lastDoneAt} onChange={(e) => setForm({ ...form, lastDoneAt: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.name} onClick={create}>
            Ajouter l&apos;actif
          </button>
        </div>
      </div>

      <ModuleSection title={`Actifs (${assets.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && assets.length === 0 ? <EmptyHint>Aucun actif pour l&apos;instant.</EmptyHint> : null}
        <div className="space-y-2.5">
          {assets.map((asset) => (
            <article key={asset.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-bold text-neutral-900">{asset.name}</h3>
                  <p className="text-[12.5px] text-neutral-500">
                    {asset.location ? `${asset.location} · ` : ""}tous les {asset.intervalDays} j · dernière {shortDate(asset.lastDoneAt)} · prochaine {shortDate(asset.nextDueAt)} · {asset.maintenanceCount} intervention(s)
                  </p>
                </div>
                <Pill tone={STATUS_TONE[asset.status] ?? "neutral"}>
                  {asset.status === "overdue" ? "En retard" : asset.status === "due_soon" ? `Dans ${asset.daysUntilDue} j` : statusLabel(asset.status)}
                </Pill>
              </div>

              {recordingId === asset.id ? (
                <div className="mt-3 rounded-xl bg-neutral-50 p-3.5">
                  <div className="grid gap-3 md:grid-cols-3">
                    <Field label="Intervenant">
                      <input className={inputCls} value={record.technician} onChange={(e) => setRecord({ ...record, technician: e.target.value })} placeholder="Tech. Dupont" />
                    </Field>
                    <Field label="Coût (optionnel)">
                      <input type="number" min="0" className={inputCls} value={record.cost} onChange={(e) => setRecord({ ...record, cost: e.target.value })} placeholder="150" />
                    </Field>
                    <Field label="Notes">
                      <input className={inputCls} value={record.notes} onChange={(e) => setRecord({ ...record, notes: e.target.value })} placeholder="Filtre remplacé" />
                    </Field>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button className={btnGhostCls} onClick={() => setRecordingId(null)}>
                      Annuler
                    </button>
                    <button className={btnPrimaryCls} disabled={busy} onClick={() => recordIntervention(asset.id)}>
                      Enregistrer l&apos;intervention
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className={btnPrimaryCls} disabled={busy} onClick={() => setRecordingId(asset.id)}>
                    Enregistrer une intervention
                  </button>
                  <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(asset.id)}>
                    Supprimer
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
