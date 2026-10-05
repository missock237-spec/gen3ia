"use client";

import { PwaInstallButton, useStandaloneInstalled } from "@/components/pwa/install-button";
import { useDevice } from "@/lib/device/use-device";

/**
 * Section « Application » des Paramètres (Task 99-c).
 *
 * Point d'installation in-app : présente l'état réel de l'appareil
 * (application installée ou navigateur), le bouton d'installation
 * natif (beforeinstallprompt) et, sur iOS — où il n'existe aucun
 * prompt programmable — les étapes « Partager → Sur l'écran d'accueil ».
 *
 * Détection iOS via le hook useDevice (lib/device) : os "ios" / "ipados"
 * (User-Agent iPhone|iPod|iPad). Le cas iPadOS 13+ déguisé en macOS,
 * sans beforeinstallprompt, reste couvert par le guide générique du
 * bouton — aucun chemin mort.
 */
export function PwaInstallSection() {
  const standalone = useStandaloneInstalled();
  const device = useDevice();
  const isIos = device?.os === "ios" || device?.os === "ipados";

  return (
    <section className="g3-gradient-border mt-6 p-6" aria-labelledby="settings-pwa-title">
      <h2 id="settings-pwa-title" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
        Application
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
        Installez Gen3ia comme une application sur votre appareil : ouverture
        plein écran sans barre d&apos;adresse, icône sur l&apos;écran
        d&apos;accueil et notifications natives. Sur PC, l&apos;Agent Live
        s&apos;utilise aussi directement dans le navigateur, sans installation.
      </p>

      <p className="mt-3 text-xs leading-5 text-[var(--g3-faint)]" role="status">
        État actuel :{" "}
        {standalone ? (
          <span className="font-semibold text-[var(--g3-success-strong)]">Application installée ✓</span>
        ) : (
          <span className="font-semibold text-[var(--g3-text-secondary)]">Navigateur</span>
        )}
      </p>

      {!standalone && (
        <div className="mt-4">
          <PwaInstallButton align="start" />
        </div>
      )}

      {!standalone && isIos && (
        <div className="mt-4 rounded-2xl bg-[var(--g3-elevated)]/60 p-4">
          <p className="text-sm font-semibold text-[var(--g3-text)]">Installation sur iPhone ou iPad</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-[var(--g3-muted)]">
            <li>Ouvrez ce site dans Safari.</li>
            <li>
              Touchez le bouton <span className="font-semibold text-[var(--g3-text)]">Partager</span>{" "}
              (le carré avec une flèche vers le haut).
            </li>
            <li>Choisissez «&nbsp;Sur l&apos;écran d&apos;accueil&nbsp;», puis «&nbsp;Ajouter&nbsp;».</li>
          </ol>
        </div>
      )}
    </section>
  );
}
