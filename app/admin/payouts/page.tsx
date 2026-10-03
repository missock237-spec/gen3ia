"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

/**
 * Console des retraits développeurs (admin uniquement — custom claim admin).
 * File requested + approved ; décisions : approuver, rejeter (libère
 * l'engagement), marquer payé (référence fournisseur exigée pour la traçabilité).
 */

interface Payout {
  id: string;
  developerId: string;
  amountMinor: number;
  currency: string;
  method: string;
  status: "requested" | "approved" | "paid" | "rejected";
  methodDetail: { accountName: string; accountNumber: string; bankName?: string | null; country: string };
  developerNote?: string | null;
  adminNote?: string | null;
  requestedAt: number;
}

const METHOD_LABELS: Record<string, string> = {
  mtn_momo: "MTN MoMo",
  orange_money: "Orange Money",
  bank_transfer: "Virement",
};

function money(amountMinor: number, currency: string) {
  return `${(amountMinor / 100).toLocaleString("fr-FR")} ${currency}`;
}

function date(value: number) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function AdminPayoutsPage() {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [providerRef, setProviderRef] = useState<Record<string, string>>({});
  const sessionDisponible = useSessionAvailable();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/payouts", { cache: "no-store" });
      const data = await response.json();
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs (claim admin manquant).");
      if (response.status === 401) throw new Error("Session expirée. Reconnectez-vous.");
      if (!response.ok) throw new Error(data.error ?? "Chargement impossible.");
      setPayouts(data.payouts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inattendue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void load();
  }, [load, sessionDisponible]);

  const decide = async (payoutId: string, decision: "approve" | "reject" | "mark_paid") => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await authFetch("/api/admin/payouts", {
        method: "POST",
        body: JSON.stringify({
          payoutId,
          decision,
          ...(note[payoutId]?.trim() ? { adminNote: note[payoutId].trim() } : {}),
          ...(decision === "mark_paid" ? { providerRef: providerRef[payoutId]?.trim() } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Décision impossible.");
      setMessage(
        decision === "approve"
          ? "Retrait approuvé."
          : decision === "reject"
            ? "Retrait rejeté — montant libéré dans le disponible du développeur."
            : "Retrait marqué payé.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Décision impossible.");
    } finally {
      setBusy(false);
    }
  };

  if (sessionDisponible === false) {
    return (
      <div className="rounded-3xl border border-white/10 bg-[var(--g3-surface)]/5 p-8 text-center">
        <h1 className="font-serif text-xl font-bold">Retraits développeurs</h1>
        <p className="mt-2 text-sm text-[var(--g3-faint)]">Connectez-vous avec un compte administrateur.</p>
        <Link href="/login" className="mt-4 inline-flex rounded-full bg-[var(--g3-surface)] px-5 py-2.5 text-sm font-semibold text-[var(--g3-text)]">Se connecter</Link>
      </div>
    );
  }

  return (
    <div>
      {message && <div className="mb-5 rounded-xl border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-200" role="status">{message}</div>}
      {error && <div className="mb-5 rounded-xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>}

      {loading ? (
        <p className="text-sm text-[var(--g3-faint)]">Chargement de la file…</p>
      ) : payouts.length === 0 ? (
        <p className="text-sm text-[var(--g3-faint)]">Aucun retrait en attente de traitement.</p>
      ) : (
        <ul className="space-y-4">
          {payouts.map((payout) => (
            <li key={payout.id} className="rounded-3xl border border-white/10 bg-[var(--g3-surface)]/5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {money(payout.amountMinor, payout.currency)} — {METHOD_LABELS[payout.method] ?? payout.method}
                  </p>
                  <p className="mt-1 text-xs text-[var(--g3-faint)]">
                    Développeur {payout.developerId} · demandé le {date(payout.requestedAt)} · statut <b>{payout.status}</b>
                  </p>
                  <p className="mt-1 text-xs text-[var(--g3-faint)]">
                    Bénéficiaire : {payout.methodDetail.accountName} ({payout.methodDetail.accountNumber}, {payout.methodDetail.country}
                    {payout.methodDetail.bankName ? `, ${payout.methodDetail.bankName}` : ""})
                  </p>
                  {payout.developerNote && <p className="mt-1 text-xs text-[var(--g3-muted)]">Note : {payout.developerNote}</p>}
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-[var(--g3-muted)]">
                  Note admin
                  <input
                    value={note[payout.id] ?? ""}
                    onChange={(event) => setNote((current) => ({ ...current, [payout.id]: event.target.value }))}
                    maxLength={500}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-xs text-[var(--g3-muted)]">
                  Référence fournisseur (pour « payé »)
                  <input
                    value={providerRef[payout.id] ?? ""}
                    onChange={(event) => setProviderRef((current) => ({ ...current, [payout.id]: event.target.value }))}
                    maxLength={200}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {payout.status === "requested" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(payout.id, "approve")}
                    className="rounded-full bg-sky-500/20 px-4 py-2 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/30 disabled:opacity-40"
                  >
                    Approuver
                  </button>
                )}
                {payout.status === "approved" && (
                  <button
                    type="button"
                    disabled={busy || !providerRef[payout.id]?.trim()}
                    onClick={() => void decide(payout.id, "mark_paid")}
                    className="rounded-full bg-emerald-500/20 px-4 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30 disabled:opacity-40"
                  >
                    Marquer payé
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(payout.id, "reject")}
                  className="rounded-full bg-red-500/20 px-4 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/30 disabled:opacity-40"
                >
                  Rejeter
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
