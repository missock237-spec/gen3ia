"use client";

import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { SettingsAdSpace } from "@/components/settings/settings-ad-space";

function SettingsContent() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-neutral-900">
      <main className="mx-auto w-full max-w-5xl px-4 py-10 md:px-8 md:py-14">
        <header>
          <p className="g3-eyebrow">GEN3IA · PARAMÈTRES</p>
          <h1 className="mt-3 font-serif text-4xl font-semibold tracking-tight md:text-5xl">Paramètres</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-neutral-500 md:text-base">
            Gérez votre espace Gen3ia, vos intégrations et les fonctionnalités disponibles sur votre compte.
          </p>
        </header>

        <section className="mt-10 rounded-3xl border border-neutral-200 bg-white p-6" aria-labelledby="settings-overview">
          <h2 id="settings-overview" className="font-serif text-2xl font-semibold">Votre espace</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-500">
            Les intégrations et paramètres métier restent accessibles depuis les sections dédiées de votre espace de travail.
          </p>
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
