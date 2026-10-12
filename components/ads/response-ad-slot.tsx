"use client";

import { useEffect, useMemo, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { pickContextualAd, stableHash } from "@/lib/ads/context-matcher";

/**
 * PUBLICITÉ INLINE — sous chaque réponse ou résultat résolu par Gen3ia.
 *
 * Demande utilisateur : « chaque utilisateur doit pouvoir avoir des pubs
 * d'annonceurs qui apparaissent dans chaque réponse ou résultat que le
 * projet résout » — puis « l'affichage ne doit PAS se faire de manière
 * aléatoire : la pub qui doit s'afficher doit avoir une similitude / un
 * trait de ressemblance avec la demande ».
 *
 * Comportement :
 *  - respecte la préférence `adsEnabled` (opt-out dans Paramètres › Publicité) ;
 *  - charge UNE FOIS par fenêtre (pool partagé, TTL 2 min) l'inventaire du
 *    placement `response_inline` : aucune requête par message, aucune
 *    tempête de requêtes dans une conversation longue ;
 *  - CIBLAGE CONTEXTUEL : la prop `context` transporte la demande de
 *    l'utilisateur (question posée + réponse) — l'annonce retenue est celle
 *    qui présente la MEILLEURE SIMILITUDE SÉMANTIQUE avec cette demande
 *    (mots-clés déclarés, racines, familles de synonymes) ;
 *  - STRICT : si AUCUNE annonce du pool ne présente de ressemblance avec la
 *    demande, RIEN ne s'affiche — jamais de choix aléatoire de substitution ;
 *  - à score ÉGAL en tête, le choix est déterministe (hachage stable de la
 *    clé) : un re-render ne change jamais l'annonce d'une ligne donnée ;
 *  - impressions enregistrées uniquement pour l'annonce RÉELLEMENT affichée
 *    (POST au montage — anti-fraude : doc-id déterministe serveur), clics
 *    mesurés au clic réel.
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
  keywords?: string[];
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
    // record=none : les impressions sont comptées à l'affichage RÉEL (le
    // ciblage contextuel n'affiche qu'une annonce du pool — pas toutes).
    const response = await authFetch("/api/ads/placement?placement=response_inline&mode=all&record=none", {
      cache: "no-store",
    });
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

export function ResponseAdSlot({ slotKey, context }: { slotKey: string; context?: string }) {
  const [ad, setAd] = useState<InlineAd | null>(null);

  useEffect(() => {
    let cancelled = false;
    const query = typeof context === "string" ? context.trim() : "";
    void loadPool().then((pool) => {
      if (cancelled || pool.ads.length === 0) return;
      let selected: InlineAd | null;
      if (query.length > 0) {
        // CIBLAGE CONTEXTUEL : seule une annonce PRÉSENTANT UNE SIMILITUDE
        // avec la demande est diffusée — sinon RIEN (jamais d'aléatoire).
        selected = pickContextualAd(pool.ads, query, slotKey);
      } else {
        // Sans contexte disponible : rotation déterministe historique
        // (hachage stable — pas de changement d'annonce au re-render).
        selected = pool.ads[stableHash(slotKey) % pool.ads.length];
      }
      if (!selected) return;
      setAd(selected);
      // Impression RÉELLE : comptée au montage effectif de l'annonce affichée
      // (le pool est chargé avec record=none pour ne rien compter en avance).
      void authFetch("/api/ads/placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "impression", adId: selected.id, placement: "response_inline" }),
      }).catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [slotKey, context]);

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
      data-contextual={typeof context === "string" && context.trim().length > 0 ? "true" : "false"}
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
