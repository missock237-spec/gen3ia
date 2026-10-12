"use client";

import { useEffect, useMemo, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * PUBLICITÉ INLINE — sous chaque réponse ou résultat résolu par Gen3ia.
 *
 * Demande utilisateur : « chaque utilisateur doit pouvoir avoir des pubs
 * d'annonceurs qui apparaissent dans chaque réponse ou résultat que le
 * projet résout ».
 *
 * Comportement :
 *  - respecte la préférence `adsEnabled` (opt-out dans Paramètres › Publicité) ;
 *  - charge UNE FOIS par fenêtre (pool partagé, TTL 2 min) l'inventaire du
 *    placement `response_inline` : aucune requête par message, aucune
 *    tempête de requêtes dans une conversation longue ;
 *  - chaque emplacement choisit DÉTERMINISTEMENT son annonce (hachage
 *    stable de la clé fournie) : la variété vient du pool, la stabilité
 *    du re-render vient du hachage — une ligne ne change pas d'annonce
 *    quand React re-rend le fil ;
 *  - impressions enregistrées côté serveur au chargement du pool, clics
 *    mesurés au clic réel (anti-fraude : doc-id déterministe serveur).
 */

interface InlineAd {
  id: string;
  format: "image" | "video" | "link";
  title: string;
  advertiser: string;
  description?: string;
  imageUrl?: string;
  targetUrl: string;
  ctaLabel?: string;
}

const POOL_TTL_MS = 120_000;

/** Cache module-level partagé par tous les emplacements de la page. */
let poolState: { ads: InlineAd[]; error: boolean; fetchedAt: number } | null = null;
let poolPromise: Promise<{ ads: InlineAd[]; error: boolean }> | null = null;

async function fetchPreferenceEnabled(): Promise<boolean> {
  try {
    const response = await authFetch("/api/settings/preferences", { cache: "no-store" });
    if (!response.ok) return true;
    const data = await response.json();
    return data.adsEnabled !== false;
  } catch {
    return true;
  }
}

async function fetchAdPool(): Promise<{ ads: InlineAd[]; error: boolean }> {
  try {
    const response = await authFetch("/api/ads/placement?placement=response_inline&mode=all", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Publicité indisponible.");
    return { ads: Array.isArray(data.ads) ? data.ads : [], error: false };
  } catch {
    return { ads: [], error: true };
  }
}

/** Charge (ou renvoie) le pool partagé : une seule requête par fenêtre. */
function loadPool(force = false): Promise<{ ads: InlineAd[]; error: boolean }> {
  const fresh = poolState && Date.now() - poolState.fetchedAt < POOL_TTL_MS;
  if (!force && fresh) {
    return Promise.resolve({ ads: poolState!.ads, error: poolState!.error });
  }
  if (!poolPromise) {
    poolPromise = (async () => {
      const [enabled, pool] = await Promise.all([fetchPreferenceEnabled(), fetchAdPool()]);
      const result = enabled ? pool : { ads: [], error: false };
      poolState = { ...result, fetchedAt: Date.now() };
      poolPromise = null;
      return result;
    })();
  }
  return poolPromise;
}

/** Hachage stable (FNV-1a) : la même clé → la même annonce, à jamais. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function ResponseAdSlot({ slotKey }: { slotKey: string }) {
  const [ad, setAd] = useState<InlineAd | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPool().then((pool) => {
      if (cancelled || pool.ads.length === 0) return;
      // Choix déterministe : le fil peut être re-rendu (streaming, mémo),
      // l'annonce d'une ligne donnée reste TOUJOURS la même.
      const index = stableHash(slotKey) % pool.ads.length;
      setAd(pool.ads[index]);
    });
    return () => {
      cancelled = true;
    };
  }, [slotKey]);

  const trackClick = useMemo(
    () => (adId: string) => {
      void authFetch("/api/ads/placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "click", adId, placement: "response_inline" }),
      }).catch(() => undefined);
    },
    [],
  );

  if (!ad) return null;

  const cta = ad.ctaLabel || "En savoir plus";

  return (
    <aside
      aria-label="Publicité sponsorisée"
      className="mr-auto w-full max-w-[92%] overflow-hidden rounded-xl border border-dashed border-[var(--g3-border)] bg-[var(--g3-surface)]/60"
      data-placement="response_inline"
    >
      <a
        href={ad.targetUrl}
        target="_blank"
        rel="noopener noreferrer sponsored"
        onClick={() => trackClick(ad.id)}
        className="flex items-center gap-3 px-3 py-2.5 transition hover:bg-[var(--g3-elevated)]"
      >
        {ad.format === "image" && ad.imageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element -- créa externe de l'inventaire publicitaire */
          <img
            src={ad.imageUrl}
            alt=""
            width={72}
            height={72}
            loading="lazy"
            className="size-11 shrink-0 rounded-lg border border-[var(--g3-border)] object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-[var(--g3-border)] bg-[var(--g3-elevated)] text-sm"
          >
            📣
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-bold uppercase tracking-[.16em] text-[var(--g3-faint)]">
            Sponsorisé · {ad.advertiser}
          </span>
          <span className="mt-0.5 block truncate text-[13px] font-semibold text-[var(--g3-text)]">{ad.title}</span>
          {ad.description && (
            <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--g3-muted)]">{ad.description}</span>
          )}
        </span>
        <span className="shrink-0 rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-1.5 text-[11px] font-semibold text-[var(--g3-text)]">
          {cta}
        </span>
      </a>
    </aside>
  );
}
