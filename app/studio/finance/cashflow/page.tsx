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

/** Module Finance — Cashflow (Data + Analytics Engines : projections 30/60/90 j). */

interface Entry {
  id: string;
  direction: "in" | "out";
  label: string;
  category: string;
  amount: number;
  currency: string;
  dueDate: string;
  status: string;
}

interface CashflowKpis {
  currency: string;
  realizedBalanceLabel: string;
  plannedIn: number;
  plannedOut: number;
  projection30: string;
  projection60: string;
  projection90: string;
  trendSlope: number;
  r2: number;
  avgMonthlyOut: number;
}

export default function FinanceCashflowPage() {
  const { items: entries, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Entry>("/api/business/finance-cashflow", "entries");
  const kpis = (extra.kpis as CashflowKpis | undefined) ?? null;
  const [form, setForm] = useState({ direction: "in", label: "", category: "general", amount: "", currency: "EUR", dueDate: "" });
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    if (await mutate("POST", {
      direction: form.direction,
      label: form.label,
      category: form.category,
      amount: Number(form.amount),
      currency: form.currency,
      dueDate: form.dueDate,
    })) {
      setNotice("Écriture ajoutée au plan de trésorerie.");
      setForm({ ...form, label: "", amount: "", dueDate: "" });
    }
  }

  async function realize(entry: Entry) {
    setNotice(null);
    if (await mutate("PATCH", { id: entry.id, status: "realized" })) setNotice("Flux réalisé — projections recalculées.");
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · FINANCE"
        title="Cashflow"
        description="Flux prévisionnels entrants et sortants : solde réalisé, reste à venir et projection de trésorerie à 30/60/90 jours par l'Analytics Engine."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      {kpis ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Solde réalisé" value={kpis.realizedBalanceLabel} />
          <StatCard label="Projection 30 j" value={kpis.projection30} />
          <StatCard label="Projection 60 j" value={kpis.projection60} />
          <StatCard label="Projection 90 j" value={kpis.projection90} hint={`tendance ${kpis.trendSlope >= 0 ? "+" : ""}${kpis.trendSlope}/j (fiabilité ${(kpis.r2 * 100).toFixed(0)} %)`} />
        </div>
      ) : null}

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Nouveau flux</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Sens">
            <select className={inputCls} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
              <option value="in">Entrée (encaissement)</option>
              <option value="out">Sortie (décaissement)</option>
            </select>
          </Field>
          <Field label="Libellé">
            <input className={inputCls} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Facture ACME-042" />
          </Field>
          <Field label="Catégorie">
            <input className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="ventes / loyer / salaires…" />
          </Field>
          <Field label="Montant">
            <input type="number" min="0.01" step="0.01" className={inputCls} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Devise">
            <select className={inputCls} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="XAF">XAF</option>
            </select>
          </Field>
          <Field label="Date prévue">
            <input type="date" className={inputCls} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.label || !form.amount || !form.dueDate} onClick={create}>
            Ajouter le flux
          </button>
        </div>
      </div>

      <ModuleSection title={`Flux (${entries.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && entries.length === 0 ? <EmptyHint>Aucun flux pour l&apos;instant. Ajoutez vos encaissements et décaissements prévus.</EmptyHint> : null}
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-neutral-50 text-[11.5px] uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2.5">Libellé</th>
                <th className="px-4 py-2.5">Catégorie</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5 text-right">Montant</th>
                <th className="px-4 py-2.5">Statut</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-neutral-100">
                  <td className="px-4 py-2.5 font-semibold text-neutral-900">{entry.label}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{entry.category}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{shortDate(entry.dueDate)}</td>
                  <td className={`px-4 py-2.5 text-right font-bold ${entry.direction === "in" ? "text-emerald-600" : "text-red-600"}`}>
                    {entry.direction === "in" ? "+" : "−"}{entry.amount.toLocaleString("fr-FR")} {entry.currency}
                  </td>
                  <td className="px-4 py-2.5">
                    <Pill tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Pill>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {entry.status === "planned" ? (
                      <button className={btnGhostCls} disabled={busy} onClick={() => realize(entry)}>
                        Réaliser
                      </button>
                    ) : (
                      <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(entry.id)}>
                        Supprimer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ModuleSection>
    </main>
  );
}
