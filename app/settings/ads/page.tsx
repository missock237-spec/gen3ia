"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { SettingsAdsGallery } from "@/components/settings/settings-ads-gallery";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Paramètres › Publicité.
 *
 * L'utilisateur visualise ici les annonces diffusées sur la plateforme et
 * contrôle leur affichage via une préférence persistée côté serveur
 * (Firestore `userSettings/{uid}` via /api/settings/preferences).
 * La diffusion réelle repose sur l'inventaire existant (`platformAds`,
 * administré depuis l'espace Admin › Publicités) : dès qu'une campagne est
 * mise en place, elle apparaît sur cette page et dans l'espace prévu.
 */
function AdsSettingsContent() {
  const [adsEnabled, setAdsEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await authFetch("/api/settings/preferences", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Préférences indisponibles.");
        setAdsEnabled(data.adsEnabled !== false);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Préférences indisponibles.");
        setAdsEnabled(true);
      }
    })();
  }, []);

  async function toggle(next: boolean) {
    if (saving) return;
    const previous = adsEnabled;
    setAdsEnabled(next);
    setSaving(true);
    setError("");
    try {
      const response = await authFetch("/api/settings/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adsEnabled: next }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Enregistrement impossible.");
      setAdsEnabled(data.adsEnabled !== false);
    } catch (reason) {
      setAdsEnabled(previous);
      setError(reason instanceof Error ? reason.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <main className="mx-auto w-full max-w-3xl px-4 py-10 md:px-8 md:py-14">
        <header>
          <Link href="/settings" className="text-xs font-semibold text-[var(--g3-muted)] transition hover:text-[var(--g3-text)]">
            ← Retour aux paramètres
          </Link>
          <h1 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">Publicité</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--g3-muted)]">
            Visualisez toutes les annonces diffusées sur Gen3ia et choisissez de les afficher ou non. Chaque campagne
            active apparaît ici pour tous les utilisateurs, avec un contrôle par compte.
          </p>
        </header>

        <section className="mt-8 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6" aria-labelledby="ads-pref-title">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="ads-pref-title" className="text-base font-bold text-[var(--g3-text)]">Afficher la publicité</h2>
              <p className="mt-1.5 text-sm leading-6 text-[var(--g3-muted)]">
                Désactivez cette option pour masquer les espaces publicitaires de votre espace Gen3ia.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={adsEnabled === true}
              disabled={adsEnabled === null || saving}
              onClick={() => void toggle(!(adsEnabled === true))}
              className={`relative h-7 w-12 shrink-0 rounded-full transition ${adsEnabled === true ? "bg-[var(--g3-primary)]" : "bg-[var(--g3-elevated)] border border-[var(--g3-border)]"}`}
            >
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${adsEnabled === true ? "left-6" : "left-1"}`} />
            </button>
          </div>
          {error && <p className="mt-3 text-xs font-semibold text-red-600" role="alert">{error}</p>}
        </section>

        <section className="mt-6" aria-labelledby="ads-current-title">
          <h2 id="ads-current-title" className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--g3-muted)]">Annonces en cours de diffusion</h2>
          {adsEnabled === false ? (
            <p className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-5 py-6 text-sm text-[var(--g3-muted)]">
              La publicité est désactivée sur votre compte. Réactivez-la ci-dessus pour voir les annonces.
            </p>
          ) : (
            <SettingsAdsGallery />
          )}
        </section>
      </main>
    </div>
  );
}

export default function AdsSettingsPage() {
  return (
    <FeatureAuthGate
      feature="Paramètres › Publicité"
      description="Connectez-vous pour gérer vos préférences publicitaires et voir les annonces diffusées."
    >
      <AdsSettingsContent />
    </FeatureAuthGate>
  );
}
