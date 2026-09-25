"use client";

import Link from "next/link";

import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { SettingsAdSpace } from "@/components/settings/settings-ad-space";

function SettingsContent() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <main className="mx-auto w-full max-w-5xl px-4 py-10 md:px-8 md:py-14">
        <header>
          <p className="g3-eyebrow">GEN3IA · PARAMÈTRES</p>
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight md:text-5xl">
            Param<span className="gradient-text">ètres</span>
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--g3-muted)] md:text-base">
            Gérez votre espace Gen3ia, vos intégrations et les fonctionnalités disponibles sur votre compte.
          </p>
        </header>

        <section className="g3-gradient-border mt-10 p-6" aria-labelledby="settings-overview">
          <h2 id="settings-overview" className="font-[family-name:var(--font-display)] text-2xl font-semibold">Votre espace</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
            Les intégrations et paramètres métier restent accessibles depuis les sections dédiées de votre espace de travail.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/settings/ads"
              className="inline-flex items-center gap-2 rounded-full border border-[rgba(124,92,255,0.35)] bg-[var(--g3-primary-soft)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[rgba(124,92,255,0.6)] hover:shadow-[0_10px_30px_-14px_rgba(124,92,255,0.6)]"
            >
              <span aria-hidden="true">📣</span> Publicité — préférences et annonces
            </Link>
          </div>
        </section>

        <section className="mt-6" aria-labelledby="settings-ad-title">
          <h2 id="settings-ad-title" className="sr-only">Publicités</h2>
          <SettingsAdSpace />
        </section>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <FeatureAuthGate
      feature="Paramètres Gen3ia"
      description="Connectez-vous pour gérer votre espace et accéder aux contenus affichés dans les paramètres."
    >
      <SettingsContent />
    </FeatureAuthGate>
  );
}
