"use client";

import { useState } from "react";
import { StudioHeader } from "@/components/studio/studio-header";
import {
  Field,
  Pill,
  EmptyHint,
  ModuleSection,
  inputCls,
  btnPrimaryCls,
  btnGhostCls,
  cardCls,
  useModuleData,
  statusTone,
  statusLabel,
  shortDate,
} from "@/components/business/kit";

/** Module Documents — Contrats (AI Engine rédaction + Document Engine PDF). */

interface Contract {
  id: string;
  title: string;
  clientName: string;
  type: string;
  amount?: number;
  currency?: string;
  status: string;
  clausesCount?: number;
  artifactId: string | null;
  filename?: string;
  signedAt?: string;
  createdAt: number;
}

const TYPE_LABELS: Record<string, string> = {
  service: "Prestation de services",
  nda: "Confidentialité (NDA)",
  sale: "Vente de biens",
  employment: "Contrat de travail",
  partnership: "Partenariat",
};

export default function DocumentsContractsPage() {
  const { items: contracts, loading, error, setError, busy, mutate, remove } = useModuleData<Contract>("/api/business/documents-contracts", "contracts");
  const [form, setForm] = useState({ title: "", clientName: "", type: "service", amount: "", currency: "EUR", startDate: "", endDate: "", paymentTerms: "", notes: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    const result = await mutate("POST", {
      action: "create",
      title: form.title,
      clientName: form.clientName,
      type: form.type,
      ...(form.amount ? { amount: Number(form.amount) } : {}),
      currency: form.currency,
      ...(form.startDate ? { startDate: form.startDate } : {}),
      ...(form.endDate ? { endDate: form.endDate } : {}),
      ...(form.paymentTerms ? { paymentTerms: form.paymentTerms } : {}),
      ...(form.notes ? { notes: form.notes } : {}),
    });
    if (result?.contract) {
      setNotice("Contrat rédigé par l'IA et exporté en PDF.");
      setOpenId(String((result.contract as { id: string }).id));
      setForm({ ...form, title: "", clientName: "", amount: "", startDate: "", endDate: "", paymentTerms: "", notes: "" });
    }
  }

  async function setStatus(id: string, status: "sent" | "signed" | "archived") {
    setNotice(null);
    if (await mutate("PATCH", { id, status })) setNotice(status === "signed" ? "Signature enregistrée — preuve horodatée PDF générée." : "Statut mis à jour.");
  }

  const open = contracts.find((c) => c.id === openId && (c as Contract & { body?: string }).body);

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · DOCUMENTS"
        title="Contrats"
        description="Décrivez les termes : l'AI Engine rédige le contrat complet (articles, clauses standard), le Document Engine produit le PDF, la signature génère une preuve horodatée."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Nouveau contrat</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Titre">
            <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Contrat de prestation — refonte site web" />
          </Field>
          <Field label="Client / partie">
            <input className={inputCls} value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="ACME SARL" />
          </Field>
          <Field label="Type">
            <select className={inputCls} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Montant (optionnel)">
              <input type="number" min="0" className={inputCls} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="5000" />
            </Field>
            <Field label="Devise">
              <select className={inputCls} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="XAF">XAF</option>
              </select>
            </Field>
          </div>
          <Field label="Début (optionnel)">
            <input type="date" className={inputCls} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="Fin (optionnel)">
            <input type="date" className={inputCls} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
          <Field label="Conditions de paiement (optionnel)">
            <input className={inputCls} value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} placeholder="30 % à la commande, solde à la livraison" />
          </Field>
          <Field label="Précisions (optionnel)">
            <input className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Maintenance incluse 3 mois" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.title || !form.clientName} onClick={create}>
            Rédiger le contrat
          </button>
        </div>
      </div>

      <ModuleSection title={`Contrats (${contracts.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && contracts.length === 0 ? <EmptyHint>Aucun contrat pour l'instant.</EmptyHint> : null}
        <div className="space-y-2.5">
          {contracts.map((contract) => (
            <article key={contract.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-bold text-neutral-900">{contract.title}</h3>
                  <p className="text-[12.5px] text-neutral-500">
                    {contract.clientName} · {TYPE_LABELS[contract.type] ?? contract.type}
                    {contract.amount ? ` · ${contract.amount} ${contract.currency ?? "EUR"}` : ""} · créé le {shortDate(contract.createdAt)}
                  </p>
                </div>
                <Pill tone={statusTone(contract.status)}>{statusLabel(contract.status)}</Pill>
              </div>

              {openId === contract.id && (contract as Contract & { body?: string }).body ? (
                <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3.5 font-sans text-[12.5px] leading-relaxed text-neutral-700">
                  {(contract as Contract & { body?: string }).body}
                </pre>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                {(contract as Contract & { body?: string }).body ? (
                  <button className={btnGhostCls} onClick={() => setOpenId(openId === contract.id ? null : contract.id)}>
                    {openId === contract.id ? "Masquer le texte" : "Voir le texte"}
                  </button>
                ) : null}
                {contract.status === "draft" ? (
                  <button className={btnGhostCls} disabled={busy} onClick={() => setStatus(contract.id, "sent")}>
                    Marquer envoyé
                  </button>
                ) : null}
                {contract.status === "sent" ? (
                  <button className={btnPrimaryCls} disabled={busy} onClick={() => setStatus(contract.id, "signed")}>
                    Enregistrer la signature
                  </button>
                ) : null}
                {contract.status !== "archived" ? (
                  <button className={btnGhostCls} disabled={busy} onClick={() => setStatus(contract.id, "archived")}>
                    Archiver
                  </button>
                ) : null}
                <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(contract.id)}>
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
