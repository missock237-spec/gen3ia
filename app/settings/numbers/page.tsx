"use client";

import { useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { StudioHeader } from "@/components/studio/studio-header";

/**
 * Paramètres · Numéros virtuels (/settings/numbers).
 *
 * L'utilisateur choisit un numéro disponible (recherche par pays/indicatif),
 * voit le prix mensuel Gen3ia (prix fournisseur + marge 20 %), sélectionne
 * l'agent destinataire et achète avec son wallet. Renouvellement mensuel
 * automatique via le cron (débit wallet, grâce 7 j, libération 30 j).
 */

interface Pricing {
  providerPriceUsdMinor: number;
  sellPriceUsdMinor: number;
  markupBps: number;
  currency: string;
  source: string;
}

interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
  isoCountry: string;
}

interface OwnedNumber {
  id: string;
  agentId: string;
  phoneNumber: string;
  status: string;
  sellPriceUsdMinor?: number;
  monthlyChargeMinor?: number;
  nextRenewalAt?: string;
  renewalNotice?: string;
}

interface AgentOption {
  id: string;
  name: string;
}

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export default function SettingsNumbersPage() {
  const [country, setCountry] = useState("US");
  const [areaCode, setAreaCode] = useState("");
  const [available, setAvailable] = useState<AvailableNumber[]>([]);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [legacyPrice, setLegacyPrice] = useState<{ monthlyPriceMinor: number; currency: string } | null>(null);
  const [owned, setOwned] = useState<OwnedNumber[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [searched, setSearched] = useState(false);

  useEffect(() => { void loadOwned(); void loadAgents(); }, []);

  async function loadOwned() {
    try {
      const response = await authFetch("/api/voice/numbers", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setOwned(data.numbers ?? []);
    } catch { /* liste indisponible : affichage vide */ }
  }

  async function loadAgents() {
    try {
      const response = await authFetch("/api/agents", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) {
        setAgents(data.agents ?? []);
        setSelectedAgent(data.agents?.[0]?.id ?? "");
      }
    } catch { /* agents indisponibles */ }
  }

  async function search() {
    setLoading(true); setError(""); setSearched(true); setSelectedNumber("");
    try {
      const params = new URLSearchParams({ country, provider: "twilio" });
      if (areaCode.trim()) params.set("areaCode", areaCode.trim());
      const response = await authFetch(`/api/voice/numbers?${params.toString()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Recherche impossible.");
      setAvailable(data.numbers ?? []);
      setPricing(data.pricing ?? null);
      setLegacyPrice(data.monthlyPriceMinor ? { monthlyPriceMinor: data.monthlyPriceMinor, currency: data.currency } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recherche impossible.");
      setAvailable([]);
    } finally {
      setLoading(false);
    }
  }

  async function buy(phoneNumber: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/voice/numbers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgent, phoneNumber }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Achat impossible.");
      setMessage(`Numéro ${data.number.phoneNumber} acheté et attribué à votre agent. Renouvellement mensuel automatique activé.`);
      await loadOwned();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Achat impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function release(id: string) {
    if (busy || !window.confirm("Libérer ce numéro ? Les appels vers ce numéro cesseront.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/voice/numbers", {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "Libération impossible.");
      setMessage("Numéro libéré.");
      await loadOwned();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Libération impossible.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "w-full rounded-xl border border-[rgba(23,23,20,0.12)] bg-white px-3 py-2 text-sm";
  const labelClass = "block text-xs font-semibold text-neutral-500 mb-1";

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <StudioHeader
        eyebrow="PARAMÈTRES · TÉLÉPHONIE"
        title="Numéros virtuels"
        description="Choisissez un numéro disponible, attribuez-le à un agent vocal et payez avec votre wallet. Le renouvellement mensuel est automatique (fournisseur + marge Gen3ia de 20 %)."
      />

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>}
      {message && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{message}</div>}

      <section className="mb-6 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-5">
        <h2 className="mb-3 text-base font-bold">Mes numéros</h2>
        {owned.length === 0 ? (
          <p className="text-sm text-neutral-500">Aucun numéro. Recherchez un numéro disponible ci-dessous.</p>
        ) : (
          <ul className="grid gap-2">
            {owned.map((number) => (
              <li key={number.id} className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(23,23,20,0.1)] bg-[#fafaf8] px-4 py-3">
                <div>
                  <p className="text-sm font-semibold">{number.phoneNumber}</p>
                  <p className="text-xs text-neutral-500">
                    agent {number.agentId.slice(0, 8)} · {number.status}
                    {number.sellPriceUsdMinor ? ` · ${usd(number.sellPriceUsdMinor)}/mois` : ""}
                    {number.nextRenewalAt ? ` · renouvellement le ${new Date(number.nextRenewalAt).toLocaleDateString("fr-FR")}` : ""}
                  </p>
                  {number.renewalNotice && <p className="text-xs text-amber-700">{number.renewalNotice}</p>}
                </div>
                <button type="button" onClick={() => void release(number.id)} disabled={busy} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700">
                  Libérer
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-5">
        <h2 className="mb-3 text-base font-bold">Acheter un numéro</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={labelClass}>Pays (ISO-2)</label>
            <input className={inputClass} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} />
          </div>
          <div>
            <label className={labelClass}>Indicatif local (optionnel)</label>
            <input className={inputClass} value={areaCode} onChange={(e) => setAreaCode(e.target.value)} maxLength={6} />
          </div>
          <div>
            <label className={labelClass}>Attribuer à l'agent</label>
            <select className={inputClass} value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </div>
        </div>
        <button type="button" onClick={() => void search()} disabled={loading || country.length !== 2} className="mt-3 rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {loading ? "Recherche…" : "Rechercher les numéros disponibles"}
        </button>

        {pricing && (
          <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            Prix mensuel : <strong>{usd(pricing.sellPriceUsdMinor)}</strong> (prix fournisseur {usd(pricing.providerPriceUsdMinor)} + marge Gen3ia {Math.round(pricing.markupBps / 100)} %). Débité depuis votre wallet, renouvellement automatique chaque mois.
          </div>
        )}
        {legacyPrice && !pricing && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Tarification mensuelle : {legacyPrice.monthlyPriceMinor} minor {legacyPrice.currency} (tarification dégradée — prix fournisseur indisponible).
          </div>
        )}

        {searched && available.length === 0 && !loading && <p className="mt-3 text-sm text-neutral-500">Aucun numéro disponible pour cette recherche. Essayez un autre pays/indicatif.</p>}
        {available.length > 0 && (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {available.slice(0, 20).map((number) => (
              <li key={number.phoneNumber} className={"flex items-center justify-between gap-2 rounded-xl border px-3 py-2 " + (selectedNumber === number.phoneNumber ? "border-neutral-900 bg-neutral-50" : "border-[rgba(23,23,20,0.1)]")}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{number.friendlyName || number.phoneNumber}</p>
                  <p className="text-xs text-neutral-500">{[number.locality, number.region].filter(Boolean).join(", ") || number.isoCountry}</p>
                </div>
                <button type="button" onClick={() => void buy(number.phoneNumber)} disabled={busy || !selectedAgent} className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">
                  {busy ? "…" : "Acheter"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
