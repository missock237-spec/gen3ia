"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Gestionnaire de campagnes PRO (Admin › Publicités) — système publicitaire
 * professionnel : objectifs, budgets plafonnés, ciblage, créas multiples,
 * statuts, programmation et MÉTRIQUES RÉELLES (impressions, clics, CTR,
 * dépense estimée, série journalière) agrégées depuis les événements réels.
 */

interface CampaignMetrics {
  campaignId: string;
  impressions: number;
  clicks: number;
  ctr: number;
  estimatedSpendMinor: number;
  daily: Array<{ day: string; impressions: number; clicks: number }>;
}

interface Campaign {
  id: string;
  name: string;
  objective: "traffic" | "conversions" | "awareness" | "engagement";
  status: "draft" | "active" | "paused" | "completed";
  dailyBudgetMinor: number;
  totalBudgetMinor?: number;
  currency: string;
  bidStrategy: string;
  frequencyCapPerDay?: number;
  targeting: { placements: string[]; languages?: string[]; keywords?: string[]; devices?: string[] };
  creatives: Array<{ headline: string; targetUrl: string; ctaLabel?: string }>;
  metrics?: CampaignMetrics | null;
}

const OBJECTIVE_LABELS: Record<Campaign["objective"], string> = {
  traffic: "Trafic",
  conversions: "Conversions",
  awareness: "Notoriété",
  engagement: "Engagement",
};

const STATUS_LABELS: Record<Campaign["status"], string> = {
  draft: "Brouillon",
  active: "Active",
  paused: "En pause",
  completed: "Terminée",
};

const STATUS_CLASSES: Record<Campaign["status"], string> = {
  draft: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  active: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  paused: "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
  completed: "bg-[var(--g3-primary-soft)] text-[var(--g3-text-secondary)]",
};

function formatMinor(amount: number, currency: string): string {
  return `${(amount / 100).toLocaleString("fr-FR")} ${currency}`;
}

const EMPTY_FORM = {
  name: "",
  objective: "traffic" as Campaign["objective"],
  dailyBudgetMinor: 5000,
  placements: "settings,workspace",
  headline: "",
  targetUrl: "https://gen3ia.online",
  frequencyCapPerDay: 6,
};

export function CampaignsManager() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/ads/campaigns", { cache: "no-store" });
      const body = (await response.json()) as { campaigns?: Campaign[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
      setCampaigns(body.campaigns ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createCampaign() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await authFetch("/api/ads/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          objective: form.objective,
          status: "active",
          dailyBudgetMinor: Number(form.dailyBudgetMinor) || 0,
          currency: "XAF",
          bidStrategy: "balanced",
          ...(form.frequencyCapPerDay ? { frequencyCapPerDay: Number(form.frequencyCapPerDay) } : {}),
          targeting: {
            placements: form.placements.split(",").map((item) => item.trim()).filter(Boolean),
          },
          creatives: [{ headline: form.headline, targetUrl: form.targetUrl, ctaLabel: "Découvrir" }],
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Création impossible.");
      setMessage("Campagne créée et diffusée selon son ciblage.");
      setForm({ ...EMPTY_FORM });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(campaign: Campaign, status: Campaign["status"]) {
    setBusy(true);
    try {
      await authFetch(`/api/ads/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeCampaign(campaign: Campaign) {
    if (!window.confirm(`Supprimer définitivement la campagne « ${campaign.name} » ?`)) return;
    setBusy(true);
    try {
      await authFetch(`/api/ads/campaigns/${campaign.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="g3-card mt-8 p-6" aria-labelledby="campaigns-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="campaigns-title" className="font-[family-name:var(--font-display)] text-xl font-bold">Campagnes PRO</h2>
        <span className="text-[11px] text-[var(--g3-faint)]">objectifs · budgets plafonnés · ciblage · fréquence · métriques réelles</span>
      </div>

      {message && <p className="mt-3 rounded-xl bg-[var(--g3-success-soft)] px-3.5 py-2.5 text-sm text-[var(--g3-success-strong)]" role="status">{message}</p>}
      {error && <p className="mt-3 rounded-xl bg-[var(--g3-danger-soft)] px-3.5 py-2.5 text-sm text-[var(--g3-danger-strong)]" role="alert">{error}</p>}

      {/* Formulaire de création */}
      <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-semibold text-[var(--g3-muted)]">
          Nom de la campagne
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none" placeholder="Lancement produit — février" />
        </label>
        <label className="text-xs font-semibold text-[var(--g3-muted)]">
          Objectif
          <select value={form.objective} onChange={(event) => setForm({ ...form, objective: event.target.value as Campaign["objective"] })}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none">
            {Object.entries(OBJECTIVE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--g3-muted)]">
          Budget journalier (mineurs)
          <input type="number" min={0} value={form.dailyBudgetMinor} onChange={(event) => setForm({ ...form, dailyBudgetMinor: Number(event.target.value) })}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none" />
        </label>
        <label className="text-xs font-semibold text-[var(--g3-muted)]">
          Plafond de fréquence / jour
          <input type="number" min={1} max={100} value={form.frequencyCapPerDay} onChange={(event) => setForm({ ...form, frequencyCapPerDay: Number(event.target.value) })}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none" />
        </label>
        <label className="text-xs font-semibold text-[var(--g3-muted)] md:col-span-2">
          Emplacements ciblés (séparés par des virgules)
          <input value={form.placements} onChange={(event) => setForm({ ...form, placements: event.target.value })}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none" placeholder="settings,workspace,marketplace" />
        </label>
        <label className="text-xs font-semibold text-[var(--g3-muted)]">
          Titre de la créa
          <input value={form.headline} onChange={(event) => setForm({ ...form, headline: event.target.value })} maxLength={160}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none" placeholder="Accélérez vos projets avec Gen3ia" />
        </label>
        <label className="text-xs font-semibold text-[var(--g3-muted)]">
          URL de destination
          <input value={form.targetUrl} onChange={(event) => setForm({ ...form, targetUrl: event.target.value })}
            className="mt-1 w-full rounded-xl bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] outline-none" />
        </label>
      </div>
      <button type="button" onClick={() => void createCampaign()} disabled={busy || form.name.trim().length < 3 || form.headline.trim().length < 3}
        className="g3-btn g3-btn-primary mt-4 text-xs disabled:opacity-40">
        {busy ? "Création…" : "Créer la campagne"}
      </button>

      {/* Liste + métriques */}
      <div className="mt-6 space-y-3">
        {loading ? (
          <p className="text-sm text-[var(--g3-muted)]" role="status">Chargement des campagnes…</p>
        ) : campaigns.length === 0 ? (
          <p className="rounded-xl bg-[var(--g3-elevated)] px-4 py-6 text-center text-sm text-[var(--g3-faint)]">
            Aucune campagne. Créez la première : objectifs, budget plafonné, ciblage par emplacement et métriques en temps réel.
          </p>
        ) : (
          campaigns.map((campaign) => (
            <article key={campaign.id} className="rounded-2xl bg-[var(--g3-elevated)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${STATUS_CLASSES[campaign.status]}`}>{STATUS_LABELS[campaign.status]}</span>
                <h3 className="text-sm font-bold text-[var(--g3-text)]">{campaign.name}</h3>
                <span className="text-[11px] text-[var(--g3-faint)]">· {OBJECTIVE_LABELS[campaign.objective]} · {formatMinor(campaign.dailyBudgetMinor, campaign.currency)}/jour</span>
                <span className="ml-auto flex gap-1.5">
                  {campaign.status !== "active" && <button type="button" onClick={() => void setStatus(campaign, "active")} className="rounded-full bg-[var(--g3-success-soft)] px-3 py-1 text-[10px] font-bold text-[var(--g3-success-strong)]">Activer</button>}
                  {campaign.status === "active" && <button type="button" onClick={() => void setStatus(campaign, "paused")} className="rounded-full bg-[var(--g3-warning-soft)] px-3 py-1 text-[10px] font-bold text-[var(--g3-warning-strong)]">Pause</button>}
                  <button type="button" onClick={() => void removeCampaign(campaign)} className="rounded-full bg-[var(--g3-danger-soft)] px-3 py-1 text-[10px] font-bold text-[var(--g3-danger-strong)]">Supprimer</button>
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--g3-faint)]">
                Ciblage : {campaign.targeting.placements.join(", ")}{campaign.targeting.devices?.length ? ` · appareils : ${campaign.targeting.devices.join("/")}` : ""}{campaign.frequencyCapPerDay ? ` · ${campaign.frequencyCapPerDay} imp./utilisateur/jour` : ""}
              </p>
              {campaign.metrics && (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Métriques réelles de la campagne">
                  <div className="rounded-xl bg-[var(--g3-surface)] px-3 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--g3-faint)]">Impressions</p>
                    <p className="text-lg font-black text-[var(--g3-text)]">{campaign.metrics.impressions.toLocaleString("fr-FR")}</p>
                  </div>
                  <div className="rounded-xl bg-[var(--g3-surface)] px-3 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--g3-faint)]">Clics</p>
                    <p className="text-lg font-black text-[var(--g3-text)]">{campaign.metrics.clicks.toLocaleString("fr-FR")}</p>
                  </div>
                  <div className="rounded-xl bg-[var(--g3-surface)] px-3 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--g3-faint)]">CTR</p>
                    <p className="text-lg font-black text-[var(--g3-text)]">{campaign.metrics.ctr}%</p>
                  </div>
                  <div className="rounded-xl bg-[var(--g3-surface)] px-3 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--g3-faint)]">Dépense estimée</p>
                    <p className="text-lg font-black text-[var(--g3-text)]">{formatMinor(campaign.metrics.estimatedSpendMinor, campaign.currency)}</p>
                  </div>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
