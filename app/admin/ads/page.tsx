"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { StatusBadge } from "@/components/shells/status-badge";

/**
 * /admin/ads — inventaire publicitaire de la plateforme (admin uniquement).
 * Gestion des emplacements in-app : création, activation/désactivation,
 * suppression. API : /api/admin/ads/placement (GET/POST/PATCH/DELETE).
 */

interface PlatformAd {
  id: string;
  placement: string;
  format: "image" | "video" | "link";
  title: string;
  advertiser: string;
  description?: string;
  targetUrl: string;
  enabled: boolean;
  priority: number;
  startsAtMs?: number;
  endsAtMs?: number;
}

const EMPTY_FORM = {
  placement: "",
  format: "link" as PlatformAd["format"],
  title: "",
  advertiser: "",
  description: "",
  targetUrl: "",
  priority: 0,
};

export default function AdminAdsPage() {
  const [ads, setAds] = useState<PlatformAd[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/ads/placement", { cache: "no-store" });
      const body = (await response.json()) as { ads?: PlatformAd[]; error?: string };
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs.");
      if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
      setAds(body.ads ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const payload: Record<string, unknown> = {
        placement: form.placement,
        format: form.format,
        title: form.title,
        advertiser: form.advertiser,
        targetUrl: form.targetUrl,
        enabled: true,
        priority: form.priority,
      };
      if (form.description.trim()) payload.description = form.description.trim();
      const response = await authFetch("/api/admin/ads/placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Création impossible.");
      setMessage("Emplacement créé.");
      setForm(EMPTY_FORM);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (ad: PlatformAd) => {
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(`/api/admin/ads/placement?id=${encodeURIComponent(ad.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !ad.enabled }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Mise à jour impossible.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mise à jour impossible.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ad: PlatformAd) => {
    if (!window.confirm(`Supprimer l'emplacement « ${ad.title} » ?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(`/api/admin/ads/placement?id=${encodeURIComponent(ad.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Suppression impossible.");
      setMessage("Emplacement supprimé.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Suppression impossible.");
    } finally {
      setBusy(false);
    }
  };

  const rows: ResourceRow[] = ads.map((ad) => ({
    id: ad.id,
    icon: ad.format === "image" ? "🖼" : ad.format === "video" ? "▶" : "⚑",
    title: ad.title,
    meta: `${ad.advertiser} · emplacement ${ad.placement} · priorité ${ad.priority}`,
    detail: ad.targetUrl ? <span className="break-all">{ad.targetUrl}</span> : undefined,
    action: (
      <span className="flex items-center gap-2">
        <StatusBadge status={ad.enabled ? "enabled" : "disabled"} />
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle(ad)}
          className="rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-white/10 disabled:opacity-40"
        >
          {ad.enabled ? "Désactiver" : "Activer"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove(ad)}
          className="rounded-full border border-red-400/40 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-400/10 disabled:opacity-40"
        >
          Supprimer
        </button>
      </span>
    ),
  }));

  return (
    <div className="space-y-7">
      {message && <div className="rounded-2xl border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-200" role="status">{message}</div>}
      {error && <div className="rounded-2xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>}

      {loading ? (
        <LoadingState rows={3} label="Chargement de l'inventaire…" />
      ) : (
        <>
          <section aria-label="Créer un emplacement" className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-lg font-bold text-neutral-100">Nouvel emplacement</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <input
                value={form.placement}
                onChange={(event) => setForm({ ...form, placement: event.target.value })}
                placeholder="Emplacement (ex. sidebar-workspace)"
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60"
              />
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="Titre"
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60"
              />
              <input
                value={form.advertiser}
                onChange={(event) => setForm({ ...form, advertiser: event.target.value })}
                placeholder="Annonceur"
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60"
              />
              <input
                value={form.targetUrl}
                onChange={(event) => setForm({ ...form, targetUrl: event.target.value })}
                placeholder="URL de destination (https://…)"
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60"
              />
              <select
                value={form.format}
                onChange={(event) => setForm({ ...form, format: event.target.value as PlatformAd["format"] })}
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60"
              >
                <option value="link">Lien</option>
                <option value="image">Image</option>
                <option value="video">Vidéo</option>
              </select>
              <input
                type="number"
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })}
                placeholder="Priorité"
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60"
              />
              <input
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="Description (facultatif)"
                className="rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-sky-400/60 sm:col-span-2 lg:col-span-2"
              />
            </div>
            <button
              type="button"
              disabled={busy || !form.placement.trim() || !form.title.trim() || !form.advertiser.trim() || !form.targetUrl.trim()}
              onClick={() => void create()}
              className="mt-4 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-40"
            >
              Créer l&apos;emplacement
            </button>
          </section>

          <section aria-label="Inventaire">
            <h2 className="mb-3 text-lg font-bold text-neutral-100">Emplacements ({ads.length})</h2>
            <ResourceList
              rows={rows}
              ariaLabel="Emplacements publicitaires"
              emptyState={<EmptyState icon="⚑" title="Aucun emplacement publicitaire" description="Créez le premier emplacement ci-dessus." />}
              className="[&_li]:border-white/10 [&_li]:bg-white/5 [&_li_*.text-neutral-800]:text-neutral-100"
            />
          </section>
        </>
      )}
    </div>
  );
}
