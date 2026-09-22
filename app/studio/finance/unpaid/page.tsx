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

/** Module Finance — Impayés (AI Engine : relances 3 niveaux + Workflow Engine). */

interface Reminder {
  level: string;
  sentAt: string;
  subject: string;
  body: string;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail?: string;
  amount: number;
  currency: string;
  issuedAt: string;
  dueDate: string;
  status: string;
  lateDays: number;
  reminders: Reminder[];
}

interface UnpaidKpis {
  currency: string;
  openCount: number;
  openTotalLabel: string;
  lateCount: number;
  lateTotalLabel: string;
  recoveryRate: number;
}

interface LastEmail {
  subject: string;
  body: string;
}

const LEVEL_LABELS: Record<string, string> = { courtoise: "Courtoise", ferme: "Ferme", mise_en_demeure: "Mise en demeure" };

export default function FinanceUnpaidPage() {
  const { items: invoices, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Invoice>("/api/business/finance-unpaid", "invoices");
  const kpis = (extra.kpis as UnpaidKpis | undefined) ?? null;
  const [form, setForm] = useState({ invoiceNumber: "", clientName: "", clientEmail: "", amount: "", currency: "EUR", issuedAt: "", dueDate: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [lastEmail, setLastEmail] = useState<LastEmail | null>(null);

  async function create() {
    setNotice(null);
    if (await mutate("POST", {
      action: "create",
      invoiceNumber: form.invoiceNumber,
      clientName: form.clientName,
      ...(form.clientEmail ? { clientEmail: form.clientEmail } : {}),
      amount: Number(form.amount),
      currency: form.currency,
      issuedAt: form.issuedAt,
      dueDate: form.dueDate,
    })) {
      setNotice("Facture ajoutée au suivi des impayés.");
      setForm({ ...form, invoiceNumber: "", clientName: "", clientEmail: "", amount: "", issuedAt: "", dueDate: "" });
    }
  }

  async function remind(invoice: Invoice, level: "courtoise" | "ferme" | "mise_en_demeure") {
    setNotice(null);
    const result = await mutate("POST", { action: "remind", invoiceId: invoice.id, level });
    if (result?.email) {
      const email = result.email as LastEmail;
      setLastEmail(email);
      setNotice(`Relance ${LEVEL_LABELS[level].toLowerCase()} générée — copiez l'e-mail ci-dessous.`);
    }
  }

  async function markPaid(id: string) {
    setNotice(null);
    if (await mutate("PATCH", { id, status: "paid" })) setNotice("Facture marquée payée.");
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · FINANCE"
        title="Impayés"
        description="Suivi des retards et relances e-mail rédigées par l'IA à trois niveaux de fermeté : courtoise, ferme, mise en demeure."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      {kpis ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Factures ouvertes" value={String(kpis.openCount)} />
          <StatCard label="Encours" value={kpis.openTotalLabel} />
          <StatCard label="En retard" value={kpis.lateTotalLabel} tone={kpis.lateCount ? "red" : "green"} hint={`${kpis.lateCount} facture(s)`} />
          <StatCard label="Taux de recouvrement" value={`${kpis.recoveryRate} %`} tone={kpis.recoveryRate >= 80 ? "green" : "amber"} />
        </div>
      ) : null}

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Nouvelle facture à suivre</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Numéro">
            <input className={inputCls} value={form.invoiceNumber} onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} placeholder="F-2026-042" />
          </Field>
          <Field label="Client">
            <input className={inputCls} value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="ACME SARL" />
          </Field>
          <Field label="E-mail client (optionnel)">
            <input type="email" className={inputCls} value={form.clientEmail} onChange={(e) => setForm({ ...form, clientEmail: e.target.value })} placeholder="compta@acme.fr" />
          </Field>
          <Field label="Montant">
            <input type="number" min="0.01" step="0.01" className={inputCls} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Émise le">
            <input type="date" className={inputCls} value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} />
          </Field>
          <Field label="Échéance">
            <input type="date" className={inputCls} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.invoiceNumber || !form.clientName || !form.amount || !form.issuedAt || !form.dueDate} onClick={create}>
            Ajouter la facture
          </button>
        </div>
      </div>

      {lastEmail ? (
        <ModuleSection title="Dernière relance générée">
          <div className={cardCls}>
            <p className="text-[13px] font-bold text-neutral-900">{lastEmail.subject}</p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3.5 font-sans text-[12.5px] leading-relaxed text-neutral-700">{lastEmail.body}</pre>
          </div>
        </ModuleSection>
      ) : null}

      <ModuleSection title={`Factures (${invoices.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && invoices.length === 0 ? <EmptyHint>Aucune facture pour l&apos;instant.</EmptyHint> : null}
        <div className="space-y-2.5">
          {invoices.map((invoice) => {
            const isLate = invoice.lateDays > 0 && !["paid", "written_off"].includes(invoice.status);
            return (
              <article key={invoice.id} className={cardCls}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[14px] font-bold text-neutral-900">
                      {invoice.invoiceNumber} <span className="font-normal text-neutral-500">· {invoice.clientName}</span>
                    </h3>
                    <p className="text-[12.5px] text-neutral-500">
                      {invoice.amount.toLocaleString("fr-FR")} {invoice.currency} · émise {shortDate(invoice.issuedAt)} · échéance {shortDate(invoice.dueDate)}
                      {invoice.reminders?.length ? ` · ${invoice.reminders.length} relance(s)` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isLate ? <Pill tone="red">{invoice.lateDays} j de retard</Pill> : null}
                    <Pill tone={statusTone(invoice.status)}>{statusLabel(invoice.status)}</Pill>
                  </div>
                </div>

                {invoice.status !== "paid" && invoice.status !== "written_off" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className={btnGhostCls} disabled={busy} onClick={() => remind(invoice, "courtoise")}>
                      Relance courtoise
                    </button>
                    <button className={btnGhostCls} disabled={busy} onClick={() => remind(invoice, "ferme")}>
                      Relance ferme
                    </button>
                    <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remind(invoice, "mise_en_demeure")}>
                      Mise en demeure
                    </button>
                    <button className={btnPrimaryCls} disabled={busy} onClick={() => markPaid(invoice.id)}>
                      Marquer payée
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex justify-end">
                    <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(invoice.id)}>
                      Supprimer
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </ModuleSection>
    </main>
  );
}
