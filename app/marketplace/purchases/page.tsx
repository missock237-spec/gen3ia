"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { authFetch } from "@/lib/firebase/auth-client";

type Purchase = {
  id: string;
  extensionId: string;
  provider: "wallet" | "chariow";
  amountMinor: number;
  currency: string;
  status: string;
  kind: "one_time" | "subscription";
  createdAt: number;
  paidAt?: number | null;
  extension?: { id: string; name: string; developerName: string; latestVersion: string | null } | null;
};

type License = {
  id: string;
  licenseKey: string;
  extensionId: string;
  purchaseId: string | null;
  status: string;
  expiresAt: number | null;
  createdAt: number;
  extension?: { id: string; name: string; developerName: string; latestVersion: string | null } | null;
};

function money(amountMinor: number, currency: string) {
  return `${(amountMinor / 100).toLocaleString("fr-FR")} ${currency}`;
}

function date(value: number) {
  return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

export default function MarketplacePurchasesPage() {
  return (
    <FeatureAuthGate feature="vos achats et licences" description="Connectez-vous pour retrouver vos achats d&apos;extensions, vos licences actives et l&apos;historique de vos transactions.">
      <PurchasesContent />
    </FeatureAuthGate>
  );
}

function PurchasesContent() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // authFetch : ID token Firebase si disponible, sinon cookie de session.
        const [purchaseResponse, licenseResponse] = await Promise.all([
          authFetch("/api/extensions/purchases?limit=100", { cache: "no-store" }),
          authFetch("/api/extensions/licenses?limit=100", { cache: "no-store" }),
        ]);
        if (!purchaseResponse.ok || !licenseResponse.ok) throw new Error("Impossible de charger vos achats et licences.");
        const purchaseData = await purchaseResponse.json();
        const licenseData = await licenseResponse.json();
        if (!cancelled) {
          setPurchases(Array.isArray(purchaseData.purchases) ? purchaseData.purchases : []);
          setLicenses(Array.isArray(licenseData.licenses) ? licenseData.licenses : []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erreur de chargement.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-full bg-[var(--g3-bg)] px-4 py-6 text-[var(--g3-text)] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <Link href="/marketplace" className="text-xs text-sky-700 hover:text-sky-800">← Marketplace</Link>
        <div className="mt-5 rounded-[30px] border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-7 shadow-[0_2px_10px_rgba(15,23,42,0.05)] sm:p-9">
          <p className="text-[10px] font-bold tracking-[.28em] text-sky-700">GEN3IA / MES ACHATS</p>
          <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight">Achats, licences et accès</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--g3-muted)]">Retrouvez vos transactions et vos licences activées. Les droits d’utilisation sont déterminés côté serveur après validation du paiement.</p>
        </div>

        {error && <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>}
        {loading ? <div className="mt-6 grid gap-4 md:grid-cols-2"><div className="h-48 animate-pulse rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)]" /><div className="h-48 animate-pulse rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)]" /></div> : (
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <div className="flex items-center justify-between"><div><h2 className="font-serif font-semibold">Licences actives</h2><p className="mt-1 text-xs text-[var(--g3-faint)]">{licenses.length} licence{licenses.length > 1 ? "s" : ""}</p></div><span className="rounded-full bg-emerald-100 px-3 py-1 text-[10px] text-emerald-600">Serveur</span></div>
              <div className="mt-5 space-y-3">
                {licenses.length === 0 ? <p className="p-6 text-center text-sm text-[var(--g3-faint)]">Aucune licence enregistrée.</p> : licenses.map((license) => (
                  <div key={license.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                    <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{license.extension?.name ?? license.extensionId}</p><p className="mt-1 text-xs text-[var(--g3-faint)]">{license.extension?.developerName ?? "Développeur"}</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] ${license.status === "active" ? "bg-emerald-100 text-emerald-600" : "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>{license.status}</span></div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-[var(--g3-faint)]"><span>Créée<br /><b className="text-[var(--g3-muted)]">{date(license.createdAt)}</b></span><span>Expiration<br /><b className="text-[var(--g3-muted)]">{license.expiresAt ? date(license.expiresAt) : "Sans expiration"}</b></span></div>
                    <div className="mt-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3 py-2 font-mono text-[10px] text-[var(--g3-muted)] break-all">{license.licenseKey}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <div><h2 className="font-serif font-semibold">Historique des achats</h2><p className="mt-1 text-xs text-[var(--g3-faint)]">{purchases.length} transaction{purchases.length > 1 ? "s" : ""}</p></div>
              <div className="mt-5 space-y-3">
                {purchases.length === 0 ? <p className="p-6 text-center text-sm text-[var(--g3-faint)]">Aucun achat enregistré.</p> : purchases.map((purchase) => (
                  <div key={purchase.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                    <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{purchase.extension?.name ?? purchase.extensionId}</p><p className="mt-1 text-xs text-[var(--g3-faint)]">{purchase.kind === "subscription" ? "Abonnement" : "Achat unique"} · {purchase.provider === "chariow" ? "Chariow" : "Wallet"}</p></div><b className="text-sm">{money(purchase.amountMinor, purchase.currency)}</b></div>
                    <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--g3-faint)]"><span>{date(purchase.paidAt ?? purchase.createdAt)}</span><span className={`rounded-full px-2.5 py-1 ${purchase.status === "paid" ? "bg-emerald-100 text-emerald-600" : purchase.status === "refunded" ? "bg-red-50 text-red-600" : "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>{purchase.status}</span></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
