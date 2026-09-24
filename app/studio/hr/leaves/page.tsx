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

/** Module RH — Congés (Data + Scheduling Engines). */

interface Leave {
  id: string;
  employeeName: string;
  type: string;
  startAt: string;
  endAt: string;
  days: number;
  allowance: number;
  status: string;
  reason?: string;
  decidedAt?: string;
}

interface Balance {
  allowance: number;
  taken: number;
  remaining: number;
}

const TYPE_LABELS: Record<string, string> = { paid: "Payé", sick: "Maladie", unpaid: "Sans solde", remote: "Télétravail" };

export default function HrLeavesPage() {
  const { items: leaves, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Leave>("/api/business/hr-leaves", "leaves");
  const balances = (extra.balances as Record<string, Balance> | undefined) ?? {};
  const [form, setForm] = useState({ employeeName: "", type: "paid", startAt: "", endAt: "", reason: "" });
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    if (await mutate("POST", { employeeName: form.employeeName, type: form.type, startAt: form.startAt, endAt: form.endAt, ...(form.reason ? { reason: form.reason } : {}) })) {
      setNotice("Demande enregistrée — jours ouvrés calculés automatiquement.");
      setForm({ ...form, employeeName: "", startAt: "", endAt: "", reason: "" });
    }
  }

  async function decide(id: string, status: "approved" | "rejected") {
    setNotice(null);
    if (await mutate("PATCH", { id, status })) setNotice(status === "approved" ? "Congé approuvé — ajouté au calendrier." : "Demande refusée.");
  }

  const pendingCount = leaves.filter((l) => l.status === "pending").length;

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · RH"
        title="Congés"
        description="Demandes avec calcul des jours ouvrés, soldes par employé, validation en un clic : les congés approuvés alimentent le calendrier commun."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Demandes en attente" value={String(pendingCount)} tone={pendingCount > 0 ? "amber" : "green"} hint={pendingCount > 0 ? "À traiter" : "Tout est traité"} />
        <StatCard label="Demandes totales" value={String(leaves.length)} />
        <StatCard label="Employés suivis" value={String(Object.keys(balances).length)} />
      </div>

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-[var(--g3-text)]">Nouvelle demande</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Employé">
            <input className={inputCls} value={form.employeeName} onChange={(e) => setForm({ ...form, employeeName: e.target.value })} placeholder="Marie Dupont" />
          </Field>
          <Field label="Type">
            <select className={inputCls} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="paid">Congé payé</option>
              <option value="sick">Maladie</option>
              <option value="unpaid">Sans solde</option>
              <option value="remote">Télétravail</option>
            </select>
          </Field>
          <Field label="Début">
            <input type="date" className={inputCls} value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} />
          </Field>
          <Field label="Fin (incluse)">
            <input type="date" className={inputCls} value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} />
          </Field>
          <Field label="Motif (optionnel)">
            <input className={inputCls} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Congés d'été" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.employeeName || !form.startAt || !form.endAt} onClick={create}>
            Enregistrer la demande
          </button>
        </div>
      </div>

      {Object.keys(balances).length ? (
        <ModuleSection title="Soldes (congés payés)">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(balances).map(([name, balance]) => (
              <StatCard
                key={name}
                label={name}
                value={`${balance.remaining} j restants`}
                hint={`alloués ${balance.allowance} j · pris ${balance.taken} j`}
              />
            ))}
          </div>
        </ModuleSection>
      ) : null}

      <ModuleSection title={`Demandes (${leaves.length})`}>
        {loading ? <p className="text-[13px] text-[var(--g3-muted)]">Chargement…</p> : null}
        {!loading && leaves.length === 0 ? <EmptyHint>Aucune demande pour l&apos;instant.</EmptyHint> : null}
        <div className="space-y-2.5">
          {leaves.map((leave) => (
            <article key={leave.id} className={cardCls}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-bold text-[var(--g3-text)]">
                    {leave.employeeName} <span className="font-normal text-[var(--g3-muted)]">· {TYPE_LABELS[leave.type] ?? leave.type}</span>
                  </h3>
                  <p className="text-[12.5px] text-[var(--g3-muted)]">
                    {shortDate(leave.startAt)} → {shortDate(leave.endAt)} · {leave.days} jour(s) ouvré(s){leave.reason ? ` · ${leave.reason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={statusTone(leave.status)}>{statusLabel(leave.status)}</Pill>
                  {leave.status === "pending" ? (
                    <>
                      <button className={btnGhostCls} disabled={busy} onClick={() => decide(leave.id, "approved")}>
                        Approuver
                      </button>
                      <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => decide(leave.id, "rejected")}>
                        Refuser
                      </button>
                    </>
                  ) : (
                    <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(leave.id)}>
                      Supprimer
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
