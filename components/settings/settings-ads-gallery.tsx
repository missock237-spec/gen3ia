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

/**
 * Galerie publicitaire de l'espace Paramètres › Publicité.
 *
 * Affiche TOUTES les annonces actuellement diffusées sur le placement
 * « settings » : chaque utilisateur connecté voit les campagnes actives
 * depuis cette interface (comportement par défaut, la préférence
 * `adsEnabled` permet de les masquer). Les clics sont mesurés par annonce.
 */
export function SettingsAdsGallery() {
  const [ads, setAds] = useState<PlatformAd[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authFetch("/api/ads/placement?placement=settings&mode=all", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Publicité indisponible.");
        if (!cancelled) setAds(Array.isArray(data.ads) ? data.ads : []);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Publicité indisponible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function track(adId: string) {
    void authFetch("/api/ads/placement", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "click", adId, placement: "settings" }),
    }).catch(() => undefined);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5"><div className="h-32 animate-pulse rounded-2xl bg-[var(--g3-elevated)]" /></section>
        <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5"><div className="h-32 animate-pulse rounded-2xl bg-[var(--g3-elevated)]" /></section>
      </div>
    );
  }

  if (error) {
    return (
      <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5"><p className="text-sm text-amber-800">{error}</p></section>
    );
  }

  if (ads.length === 0) return null;

  return (
    <div className="space-y-4" aria-label="Publicités en cours de diffusion">
      {ads.map((ad, index) => {
        const cta = ad.ctaLabel || "En savoir plus";
        return (
          <section
            key={ad.id}
            className="overflow-hidden rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-[0_8px_30px_-18px_rgba(15,23,42,0.2)]"
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--g3-border)] px-5 py-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Espace publicitaire</p>
                <p className="mt-0.5 text-[10px] text-[var(--g3-faint)]">Publicité sponsorisée · {index + 1}/{ads.length}</p>
              </div>
              <span className="rounded-full bg-[var(--g3-elevated)] px-2.5 py-1 text-[10px] font-semibold text-[var(--g3-muted)]">{ad.advertiser}</span>
            </div>

            {ad.format === "image" && ad.imageUrl && (
              <a
                href={ad.targetUrl}
                target="_blank"
                rel="noopener noreferrer sponsored"
                onClick={() => void track(ad.id)}
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
                  onPlay={() => { void track(ad.id); }}
                >
                  Votre navigateur ne prend pas en charge la vidéo.
                </video>
              </div>
            )}

            <div className="space-y-3 p-5">
              <div>
                <h3 className="text-lg font-semibold text-[var(--g3-text)]">{ad.title}</h3>
                {ad.description && <p className="mt-1.5 text-sm leading-6 text-[var(--g3-muted)]">{ad.description}</p>}
                {ad.text && <p className="mt-2 text-sm font-medium text-[var(--g3-text-secondary)]">{ad.text}</p>}
              </div>
              <a
                href={ad.targetUrl}
                target="_blank"
                rel="noopener noreferrer sponsored"
                onClick={() => void track(ad.id)}
                className="inline-flex items-center rounded-full bg-[var(--g3-deep)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-elevated)]"
              >
                {cta}
              </a>
            </div>
          </section>
        );
      })}
    </div>
  );
}
