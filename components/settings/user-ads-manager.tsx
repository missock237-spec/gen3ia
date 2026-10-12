"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * GEN ADS — gestionnaire de campagnes publicitaires UTILISATEUR.
 *
 * Demande utilisateur : « dans paramètres gen ads les utilisateurs doivent
 * pouvoir mettre en avant leur pub dans le projet ».
 *
 * L'utilisateur crée ici ses propres campagnes (annonceur, objectif, budget,
 * ciblage par emplacements, créations). Une campagne ACTIVE est publiée dans
 * l'inventaire de diffusion : elle apparaît dans le projet — y compris sous
 * chaque réponse ou résultat résolu par Gen3ia. Les métriques affichées sont
 * RÉELLES (impressions et clics enregistrés par la plateforme).
 */

type CampaignObjective = "traffic" | "conversions" | "awareness" | "engagement";
type CampaignStatus = "draft" | "active" | "paused" | "completed";
type BidStrategy = "maximize_reach" | "maximize_ctr" | "balanced";

interface CampaignCreative {
  headline: string;
  description?: string;
  targetUrl: string;
  imageUrl?: string;
  ctaLabel?: string;
}

interface AdCampaign {
  id: string;
  name: string;
  advertiserName?: string;
  objective: CampaignObjective;
  status: CampaignStatus;
  dailyBudgetMinor: number;
  currency: string;
  bidStrategy: BidStrategy;
  frequencyCapPerDay?: number;
  targeting: { placements: string[]; keywords?: string[] };
  creatives: CampaignCreative[];
  createdAtMs: number;
  metrics?: {
    impressions: number;
    clicks: number;
    ctr: number;
    estimatedSpendMinor: number;
  } | null;
}

interface AdPlacementInfo {
  id: string;
  label: string;
  description: string;
}

const OBJECTIVE_LABELS: Record<CampaignObjective, string> = {
  traffic: "Trafic vers un site",
  conversions: "Conversions",
  awareness: "Notoriété",
  engagement: "Engagement",
};

const STRATEGY_LABELS: Record<BidStrategy, string> = {
  maximize_reach: "Portée maximale",
  maximize_ctr: "CTR maximal",
  balanced: "Équilibrée",
};

const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Brouillon",
  active: "Active",
  paused: "En pause",
  completed: "Terminée",
};

interface CreativeDraft {
  headline: string;
  description: string;
  targetUrl: string;
  imageUrl: string;
  ctaLabel: string;
}

const EMPTY_CREATIVE: CreativeDraft = {
  headline: "",
  description: "",
  targetUrl: "",
  imageUrl: "",
  ctaLabel: "",
};

/** Formatage monétaire : mineurs (centimes) → affichage lisible. */
function formatMinor(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(major);
  } catch {
    return `${major.toLocaleString("fr-FR")} ${currency}`;
  }
}

export function UserAdsManager() {
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [placements, setPlacements] = useState<AdPlacementInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [formOpen, setFormOpen] = useState(false);

  // Formulaire de création.
  const [name, setName] = useState("");
  const [advertiserName, setAdvertiserName] = useState("");
  const [objective, setObjective] = useState<CampaignObjective>("traffic");
  const [bidStrategy, setBidStrategy] = useState<BidStrategy>("balanced");
  const [dailyBudget, setDailyBudget] = useState("5000");
  const [frequencyCap, setFrequencyCap] = useState("");
  const [selectedPlacements, setSelectedPlacements] = useState<string[]>(["response_inline"]);
  const [creatives, setCreatives] = useState<CreativeDraft[]>([{ ...EMPTY_CREATIVE }]);
  const [activateNow, setActivateNow] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadCampaigns = useCallback(async () => {
    try {
      const response = await authFetch("/api/ads/my-campaigns", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Campagnes indisponibles.");
      setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
      setPlacements(Array.isArray(data.placements) ? data.placements : []);
      setListError("");
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : "Campagnes indisponibles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const placementLabel = useCallback(
    (id: string) => placements.find((placement) => placement.id === id)?.label ?? id,
    [placements],
  );

  const togglePlacement = (id: string) => {
    setSelectedPlacements((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 6),
    );
  };

  const updateCreative = (index: number, patch: Partial<CreativeDraft>) => {
    setCreatives((current) => current.map((creative, i) => (i === index ? { ...creative, ...patch } : creative)));
  };

  async function submitCampaign() {
    if (submitting) return;
    setFormError("");
    setNotice("");
    const budgetValue = Number(dailyBudget.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(budgetValue) || budgetValue < 0) {
      setFormError("Le budget journalier doit être un nombre positif.");
      return;
    }
    const frequency = frequencyCap.trim() ? Number(frequencyCap) : undefined;
    if (frequency !== undefined && (!Number.isInteger(frequency) || frequency < 1 || frequency > 100)) {
      setFormError("Le plafond de fréquence doit être un entier entre 1 et 100.");
      return;
    }
    if (selectedPlacements.length === 0) {
      setFormError("Sélectionnez au moins un emplacement de diffusion.");
      return;
    }
    const validCreatives = creatives
      .filter((creative) => creative.headline.trim().length >= 3 && creative.targetUrl.trim())
      .map((creative) => ({
        headline: creative.headline.trim(),
        ...(creative.description.trim() ? { description: creative.description.trim() } : {}),
        targetUrl: creative.targetUrl.trim(),
        ...(creative.imageUrl.trim() ? { imageUrl: creative.imageUrl.trim() } : {}),
        ...(creative.ctaLabel.trim() ? { ctaLabel: creative.ctaLabel.trim() } : {}),
      }));
    if (validCreatives.length === 0) {
      setFormError("Ajoutez au moins une création (titre de 3+ caractères et URL de destination).");
      return;
    }

    setSubmitting(true);
    try {
      const response = await authFetch("/api/ads/my-campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(advertiserName.trim() ? { advertiserName: advertiserName.trim() } : {}),
          objective,
          status: activateNow ? "active" : "draft",
          dailyBudgetMinor: Math.round(budgetValue * 100),
          currency: "XAF",
          bidStrategy,
          ...(frequency !== undefined ? { frequencyCapPerDay: frequency } : {}),
          targeting: { placements: selectedPlacements },
          creatives: validCreatives,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Création de campagne impossible.");
      setNotice(
        data.publishedAds > 0
          ? `Campagne publiée : ${data.publishedAds} annonce(s) maintenant en diffusion dans le projet.`
          : "Campagne enregistrée en brouillon. Activez-la pour la mettre en avant.",
      );
      setName("");
      setAdvertiserName("");
      setCreatives([{ ...EMPTY_CREATIVE }]);
      setFormOpen(false);
      await loadCampaigns();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Création de campagne impossible.");
    } finally {
      setSubmitting(false);
    }
  }

  async function patchCampaign(id: string, status: CampaignStatus) {
    if (busyId) return;
    setBusyId(id);
    setNotice("");
    setListError("");
    try {
      const response = await authFetch(`/api/ads/my-campaigns/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Mise à jour impossible.");
      setNotice(
        data.publishedAds > 0
          ? "Campagne active : vos annonces sont de nouveau mises en avant dans le projet."
          : "Campagne en pause : vos annonces ne sont plus diffusées.",
      );
      await loadCampaigns();
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : "Mise à jour impossible.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeCampaign(id: string) {
    if (busyId) return;
    if (!window.confirm("Supprimer définitivement cette campagne et toutes ses annonces ?")) return;
    setBusyId(id);
    setNotice("");
    setListError("");
    try {
      const response = await authFetch(`/api/ads/my-campaigns/${id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Suppression impossible.");
      setNotice("Campagne supprimée : ses annonces ne sont plus diffusées.");
      await loadCampaigns();
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : "Suppression impossible.");
    } finally {
      setBusyId(null);
    }
  }

  const totalImpressions = useMemo(
    () => campaigns.reduce((sum, campaign) => sum + (campaign.metrics?.impressions ?? 0), 0),
    [campaigns],
  );
  const totalClicks = useMemo(
    () => campaigns.reduce((sum, campaign) => sum + (campaign.metrics?.clicks ?? 0), 0),
    [campaigns],
  );

  return (
    <section
      className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6"
      aria-labelledby="gen-ads-manager-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 id="gen-ads-manager-title" className="text-base font-bold text-[var(--g3-text)]">
            Vos campagnes — Gen Ads
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--g3-muted)]">
            Mettez en avant VOTRE publicité dans le projet : créez une campagne, ciblez les emplacements de diffusion
            (y compris sous chaque réponse ou résultat de l&apos;IA) et suivez ses performances réelles.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setFormOpen((open) => !open)}
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[var(--g3-deep)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-elevated)]"
        >
          {formOpen ? "Annuler" : "＋ Créer une campagne"}
        </button>
      </div>

      {campaigns.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Campagnes</dt>
            <dd className="mt-1 text-lg font-bold text-[var(--g3-text)]">{campaigns.length}</dd>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Actives</dt>
            <dd className="mt-1 text-lg font-bold text-[var(--g3-text)]">
              {campaigns.filter((campaign) => campaign.status === "active").length}
            </dd>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Impressions</dt>
            <dd className="mt-1 text-lg font-bold text-[var(--g3-text)]">{totalImpressions.toLocaleString("fr-FR")}</dd>
          </div>
          <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Clics</dt>
            <dd className="mt-1 text-lg font-bold text-[var(--g3-text)]">{totalClicks.toLocaleString("fr-FR")}</dd>
          </div>
        </dl>
      )}

      {notice && (
        <p className="mt-4 rounded-2xl border border-[var(--g3-success-soft,var(--g3-border))] bg-[var(--g3-success-soft,var(--g3-elevated))] px-4 py-3 text-sm font-medium text-[var(--g3-text)]" role="status">
          {notice}
        </p>
      )}

      {formOpen && (
        <form
          className="mt-6 space-y-5 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCampaign();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-[var(--g3-text)]">Nom de la campagne</span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                minLength={3}
                maxLength={120}
                placeholder="Ex. Lancement de ma boutique"
                className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-[var(--g3-text)]">Nom de l&apos;annonceur (affiché)</span>
              <input
                type="text"
                value={advertiserName}
                onChange={(event) => setAdvertiserName(event.target.value)}
                minLength={2}
                maxLength={120}
                placeholder="Ex. Ma Boutique SARL"
                className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-sm">
              <span className="font-medium text-[var(--g3-text)]">Objectif</span>
              <select
                value={objective}
                onChange={(event) => setObjective(event.target.value as CampaignObjective)}
                className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
              >
                {Object.entries(OBJECTIVE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-[var(--g3-text)]">Stratégie d&apos;enchère</span>
              <select
                value={bidStrategy}
                onChange={(event) => setBidStrategy(event.target.value as BidStrategy)}
                className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
              >
                {Object.entries(STRATEGY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-[var(--g3-text)]">Budget journalier (XAF)</span>
              <input
                type="number"
                min={0}
                step={100}
                value={dailyBudget}
                onChange={(event) => setDailyBudget(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-[var(--g3-text)]">Plafond / jour (optionnel)</span>
              <input
                type="number"
                min={1}
                max={100}
                value={frequencyCap}
                onChange={(event) => setFrequencyCap(event.target.value)}
                placeholder="Impressions max par utilisateur"
                className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
              />
            </label>
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-[var(--g3-text)]">Emplacements de diffusion</legend>
            <p className="mt-1 text-xs text-[var(--g3-muted)]">
              Où votre publicité sera mise en avant dans le projet.
            </p>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {placements.map((placement) => (
                <label
                  key={placement.id}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm transition ${
                    selectedPlacements.includes(placement.id)
                      ? "border-[var(--g3-primary)] bg-[var(--g3-primary-soft)]"
                      : "border-[var(--g3-border)] bg-[var(--g3-surface)]"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPlacements.includes(placement.id)}
                    onChange={() => togglePlacement(placement.id)}
                    className="mt-0.5 accent-[var(--g3-primary)]"
                  />
                  <span>
                    <span className="font-semibold text-[var(--g3-text)]">{placement.label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--g3-muted)]">{placement.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-medium text-[var(--g3-text)]">Création(s) publicitaire(s)</legend>
            {creatives.map((creative, index) => (
              <div key={`creative-${index}`} className="space-y-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Création {index + 1}</p>
                  {creatives.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setCreatives((current) => current.filter((_, i) => i !== index))}
                      className="text-xs font-semibold text-[var(--g3-danger-strong)] transition hover:underline"
                    >
                      Retirer
                    </button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="font-medium text-[var(--g3-text)]">Titre de l&apos;annonce</span>
                    <input
                      type="text"
                      value={creative.headline}
                      onChange={(event) => updateCreative(index, { headline: event.target.value })}
                      minLength={3}
                      maxLength={160}
                      placeholder="Ex. -30% sur toute la collection"
                      className="mt-1 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="font-medium text-[var(--g3-text)]">URL de destination</span>
                    <input
                      type="url"
                      value={creative.targetUrl}
                      onChange={(event) => updateCreative(index, { targetUrl: event.target.value })}
                      placeholder="https://mon-site.com"
                      className="mt-1 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
                    />
                  </label>
                  <label className="block text-sm sm:col-span-2">
                    <span className="font-medium text-[var(--g3-text)]">Description (optionnel)</span>
                    <input
                      type="text"
                      value={creative.description}
                      onChange={(event) => updateCreative(index, { description: event.target.value })}
                      maxLength={500}
                      placeholder="Une phrase qui donne envie de cliquer."
                      className="mt-1 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="font-medium text-[var(--g3-text)]">URL d&apos;image (optionnel)</span>
                    <input
                      type="url"
                      value={creative.imageUrl}
                      onChange={(event) => updateCreative(index, { imageUrl: event.target.value })}
                      placeholder="https://mon-site.com/banniere.jpg"
                      className="mt-1 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="font-medium text-[var(--g3-text)]">Libellé du bouton (optionnel)</span>
                    <input
                      type="text"
                      value={creative.ctaLabel}
                      onChange={(event) => updateCreative(index, { ctaLabel: event.target.value })}
                      maxLength={60}
                      placeholder="Ex. En profiter"
                      className="mt-1 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
                    />
                  </label>
                </div>
              </div>
            ))}
            {creatives.length < 3 && (
              <button
                type="button"
                onClick={() => setCreatives((current) => [...current, { ...EMPTY_CREATIVE }])}
                className="text-sm font-semibold text-[var(--g3-primary)] transition hover:underline"
              >
                ＋ Ajouter une création
              </button>
            )}
          </fieldset>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[var(--g3-text)]">
            <input
              type="checkbox"
              checked={activateNow}
              onChange={(event) => setActivateNow(event.target.checked)}
              className="accent-[var(--g3-primary)]"
            />
            Activer immédiatement — ma publicité sera mise en avant dans le projet dès maintenant.
          </label>

          {formError && <p className="text-xs font-semibold text-[var(--g3-danger-strong)]" role="alert">{formError}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--g3-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Publication…" : "Publier ma campagne"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="mt-6 space-y-3">
          <div className="h-24 animate-pulse rounded-2xl bg-[var(--g3-elevated)]" />
          <div className="h-24 animate-pulse rounded-2xl bg-[var(--g3-elevated)]" />
        </div>
      ) : listError ? (
        <p className="mt-4 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {listError}
        </p>
      ) : campaigns.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-[var(--g3-border)] px-5 py-8 text-center text-sm text-[var(--g3-muted)]">
          Vous n&apos;avez pas encore de campagne. Créez-en une pour mettre en avant votre publicité dans Gen3ia —
          elle apparaîtra notamment sous chaque réponse ou résultat de l&apos;IA.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {campaigns.map((campaign) => (
            <li
              key={campaign.id}
              className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-bold text-[var(--g3-text)]">{campaign.name}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        campaign.status === "active"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : campaign.status === "paused"
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-[var(--g3-surface)] text-[var(--g3-muted)]"
                      }`}
                    >
                      {STATUS_LABELS[campaign.status]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--g3-muted)]">
                    {campaign.advertiserName || "Annonceur privé"} · {formatMinor(campaign.dailyBudgetMinor, campaign.currency)}/j ·{" "}
                    {STRATEGY_LABELS[campaign.bidStrategy]}
                    {campaign.frequencyCapPerDay ? ` · max ${campaign.frequencyCapPerDay}/j/utilisateur` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {campaign.targeting.placements.map((placement) => (
                      <span
                        key={`${campaign.id}-placement-${placement}`}
                        className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--g3-text-secondary)]"
                      >
                        {placementLabel(placement)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {campaign.status === "active" ? (
                    <button
                      type="button"
                      disabled={busyId === campaign.id}
                      onClick={() => void patchCampaign(campaign.id, "paused")}
                      className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-1.5 text-xs font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-border-strong)] disabled:opacity-50"
                    >
                      Mettre en pause
                    </button>
                  ) : campaign.status !== "completed" ? (
                    <button
                      type="button"
                      disabled={busyId === campaign.id}
                      onClick={() => void patchCampaign(campaign.id, "active")}
                      className="rounded-full bg-[var(--g3-primary)] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      Activer
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busyId === campaign.id}
                    onClick={() => void removeCampaign(campaign.id)}
                    className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3.5 py-1.5 text-xs font-semibold text-[var(--g3-danger-strong)] transition hover:border-[var(--g3-danger-strong)] disabled:opacity-50"
                  >
                    Supprimer
                  </button>
                </div>
              </div>

              {campaign.metrics && (
                <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--g3-border)] pt-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Impr.</p>
                    <p className="text-sm font-bold text-[var(--g3-text)]">{campaign.metrics.impressions.toLocaleString("fr-FR")}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Clics</p>
                    <p className="text-sm font-bold text-[var(--g3-text)]">{campaign.metrics.clicks.toLocaleString("fr-FR")}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">CTR</p>
                    <p className="text-sm font-bold text-[var(--g3-text)]">{campaign.metrics.ctr.toFixed(2)}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-faint)]">Dépense est.</p>
                    <p className="text-sm font-bold text-[var(--g3-text)]">
                      {formatMinor(campaign.metrics.estimatedSpendMinor, campaign.currency)}
                    </p>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
