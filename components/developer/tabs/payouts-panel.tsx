"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { LoadingState } from "@/components/shells/states";
import { Card, Panel } from "@/components/developer/tabs/panel";

/**
 * Onglet Revenus & retraits — solde (gagné / engagé / disponible), demande de
 * retrait et historique des mandats. Le solde disponible est calculé côté
 * serveur (agrégat des revenus nets − engagements transactionnels) ; le
 * frontend n'est jamais une preuve de solde.
 */

interface PayoutDoc {
  id: string;
  amountMinor: number;
  currency: string;
  method: string;
  status: "requested" | "approved" | "paid" | "rejected";
  methodDetail: { accountName: string; accountNumber: string; bankName?: string | null; country: string };
  developerNote?: string | null;
  adminNote?: string | null;
  providerRef?: string | null;
  requestedAt: number;
  decidedAt?: number | null;
  paidAt?: number | null;
}

interface Balance {
  earnedMinor: number;
  committedMinor: number;
  availableMinor: number;
  currency: string;
  minPayoutMinor: number;
  payoutCount: number;
}

interface PayoutPayload {
  balance: Balance | null;
  payouts: PayoutDoc[];
  methods: Array<{ id: string; label: string }>;
}

const STATUS_LABELS: Record<PayoutDoc["status"], string> = {
  requested: "En file",
  approved: "Approuvé",
  paid: "Payé",
  rejected: "Rejeté",
};

const STATUS_CLASSES: Record<PayoutDoc["status"], string> = {
  requested: "bg-amber-100 text-amber-900",
  approved: "bg-sky-100 text-sky-900",
  paid: "bg-emerald-100 text-emerald-900",
  rejected: "bg-neutral-200 text-neutral-700",
};

const COUNTRY_CODES = ["CM", "CI", "SN", "BF", "ML", "GA", "CG", "CD", "FR", "BE", "CA"];

function formatMinor(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString("fr-FR")} ${currency}`;
}

function formatDate(ms?: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export function PayoutsPanel() {
  const [data, setData] = useState<PayoutPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("mtn_momo");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [country, setCountry] = useState("CM");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/developer/payouts", { cache: "no-store" });
      const payload = (await response.json()) as PayoutPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Chargement impossible.");
      setData(payload);
      if (payload.methods?.length && !payload.methods.some((m) => m.id === method)) {
        setMethod(payload.methods[0].id);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Erreur inattendue.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const amountValue = Number(amount);
      if (!Number.isFinite(amountValue) || amountValue <= 0) throw new Error("Saisissez un montant valide.");
      const response = await authFetch("/api/developer/payouts", {
        method: "POST",
        body: JSON.stringify({
          amountMinor: Math.round(amountValue * 100),
          method,
          methodDetail: {
            accountName,
            accountNumber,
            bankName: method === "bank_transfer" ? bankName : null,
            country,
          },
          developerNote: note || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Demande refusée.");
      setMessage("Demande de retrait enregistrée — traitement sous 48 h ouvrées.");
      setAmount("");
      setNote("");
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Erreur inattendue.");
    } finally {
      setSubmitting(false);
    }
  }, [amount, method, accountName, accountNumber, bankName, country, note, load]);

  if (loading && !data) return <LoadingState rows={4} />;

  const balance = data?.balance ?? null;
  const minMajor = balance ? balance.minPayoutMinor / 100 : null;

  return (
    <section className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Revenus nets cumulés" value={balance ? formatMinor(balance.earnedMinor, balance.currency) : "—"} hint="Après commission de plateforme" />
        <Card title="Engagé (retraits en cours)" value={balance ? formatMinor(balance.committedMinor, balance.currency) : "—"} hint={`${balance?.payoutCount ?? 0} demande(s) au total`} />
        <Card title="Disponible" value={balance ? formatMinor(balance.availableMinor, balance.currency) : "—"} hint={minMajor ? `Retrait minimum : ${minMajor.toLocaleString("fr-FR")} ${balance?.currency ?? ""}` : undefined} />
      </div>

      <Panel title="Demander un retrait" subtitle="Le paiement est traité par l&apos;équipe Gen3ia vers votre compte Mobile Money ou bancaire.">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="text-xs text-[var(--g3-muted)]">
            Montant ({balance?.currency ?? "XAF"})
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              required
              className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900"
              placeholder={minMajor ? `≥ ${minMajor}` : "5000"}
            />
          </label>
          <label className="text-xs text-[var(--g3-muted)]">
            Moyen de paiement
            <select value={method} onChange={(event) => setMethod(event.target.value)} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900">
              {(data?.methods ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--g3-muted)]">
            Nom du titulaire
            <input value={accountName} onChange={(event) => setAccountName(event.target.value)} required maxLength={120} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900" />
          </label>
          <label className="text-xs text-[var(--g3-muted)]">
            {method === "bank_transfer" ? "IBAN / compte" : "Numéro Mobile Money"}
            <input value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} required maxLength={60} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900" />
          </label>
          {method === "bank_transfer" && (
            <label className="text-xs text-[var(--g3-muted)]">
              Banque
              <input value={bankName} onChange={(event) => setBankName(event.target.value)} required maxLength={120} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900" />
            </label>
          )}
          <label className="text-xs text-[var(--g3-muted)]">
            Pays du compte
            <select value={country} onChange={(event) => setCountry(event.target.value)} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900">
              {COUNTRY_CODES.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--g3-muted)] sm:col-span-2">
            Note (optionnel)
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2 text-sm text-neutral-900" />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={submitting || !balance || balance.availableMinor < (balance?.minPayoutMinor ?? 0)}
              className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Envoi…" : "Demander le retrait"}
            </button>
          </div>
        </form>
        {message && <p className="mt-3 text-xs text-emerald-700">{message}</p>}
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </Panel>

      <Panel title="Historique des retraits" subtitle={`${data?.payouts.length ?? 0} mandat(s)`}>
        {!data || data.payouts.length === 0 ? (
          <p className="text-sm text-[var(--g3-muted)]">Aucun retrait pour l&apos;instant.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[var(--g3-muted)]">
                <tr>
                  <th className="py-2 pr-3">Demandé le</th>
                  <th className="py-2 pr-3">Montant</th>
                  <th className="py-2 pr-3">Moyen</th>
                  <th className="py-2 pr-3">Bénéficiaire</th>
                  <th className="py-2 pr-3">Statut</th>
                  <th className="py-2 pr-3">Décision</th>
                </tr>
              </thead>
              <tbody>
                {data.payouts.map((payout) => (
                  <tr key={payout.id} className="border-t">
                    <td className="py-2 pr-3">{formatDate(payout.requestedAt)}</td>
                    <td className="py-2 pr-3 font-semibold">{formatMinor(payout.amountMinor, payout.currency)}</td>
                    <td className="py-2 pr-3">{data.methods.find((m) => m.id === payout.method)?.label ?? payout.method}</td>
                    <td className="py-2 pr-3">
                      {payout.methodDetail.accountName}
                      <br />
                      <span className="text-[var(--g3-faint)]">{payout.methodDetail.accountNumber}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASSES[payout.status]}`}>{STATUS_LABELS[payout.status]}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {formatDate(payout.decidedAt)}
                      {payout.providerRef ? <><br /><span className="text-[var(--g3-faint)]">réf. {payout.providerRef}</span></> : null}
                      {payout.adminNote ? <><br /><span className="text-[var(--g3-faint)]">{payout.adminNote}</span></> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}
