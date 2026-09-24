"use client";

import { useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

type PlatformAd = {
  id: string;
  format: "image" | "video" | "link";
  title: string;
  advertiser: string;
  description?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  targetUrl: string;
  ctaLabel?: string;
};

export function SettingsAdSpace() {
  const [ad, setAd] = useState<PlatformAd | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authFetch("/api/ads/placement?placement=settings", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Publicité indisponible.");
        if (!cancelled) setAd(data.ad ?? null);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Publicité indisponible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function track(action: "click") {
    if (!ad) return;
    void authFetch("/api/ads/placement", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, adId: ad.id, placement: "settings" }),
    }).catch(() => undefined);
  }

  if (loading) {
    return <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5"><div className="h-32 animate-pulse rounded-2xl bg-[var(--g3-elevated)]" /></section>;
  }

  if (error) {
    return <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5"><p className="text-sm text-amber-800">{error}</p></section>;
  }

  if (!ad) return null;

  const cta = ad.ctaLabel || "En savoir plus";

  return (
    <section className="overflow-hidden rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-[0_8px_30px_-18px_rgba(15,23,42,0.2)]" aria-label="Publicité">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--g3-border)] px-5 py-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Espace publicitaire</p>
          <p className="mt-0.5 text-[10px] text-[var(--g3-faint)]">Publicité sponsorisée</p>
        </div>
        <span className="rounded-full bg-[var(--g3-elevated)] px-2.5 py-1 text-[10px] font-semibold text-[var(--g3-muted)]">{ad.advertiser}</span>
      </div>

      {ad.format === "image" && ad.imageUrl && (
        <a
          href={ad.targetUrl}
          target="_blank"
          rel="noopener noreferrer sponsored"
          onClick={() => void track("click")}
          className="block bg-[var(--g3-elevated)]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- creative URL externe fournie par l'inventaire publicitaire */}
          <img src={ad.imageUrl} alt={ad.title} className="max-h-[320px] w-full object-cover" loading="lazy" />
        </a>
      )}

      {ad.format === "video" && ad.videoUrl && (
        <div className="bg-black">
          <video
            src={ad.videoUrl}
            controls
            playsInline
            preload="metadata"
            className="max-h-[360px] w-full"
            onPlay={() => { void track("click"); }}
          >
            Votre navigateur ne prend pas en charge la vidéo.
          </video>
        </div>
      )}

      <div className="space-y-3 p-5">
        <div>
          <h2 className="text-lg font-semibold text-[var(--g3-text)]">{ad.title}</h2>
          {ad.description && <p className="mt-1.5 text-sm leading-6 text-[var(--g3-muted)]">{ad.description}</p>}
          {ad.text && <p className="mt-2 text-sm font-medium text-[var(--g3-text-secondary)]">{ad.text}</p>}
        </div>
        <a
          href={ad.targetUrl}
          target="_blank"
          rel="noopener noreferrer sponsored"
          onClick={() => void track("click")}
          className="inline-flex items-center rounded-full bg-[var(--g3-deep)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-elevated)]"
        >
          {cta}
        </a>
      </div>
    </section>
  );
}
