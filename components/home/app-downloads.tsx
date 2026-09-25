"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Bouton d'installation PWA (Android / Chrome / Edge).
 * Utilise l'événement natif beforeinstallprompt ; si indisponible
 * (iOS, déjà installé, navigateur non compatible), affiche un guide court.
 */
function PwaInstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [guide, setGuide] = useState<null | "ios" | "generique">(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setGuide(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia("(display-mode: standalone)").matches) setInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) {
    return <span className="text-xs font-semibold text-[var(--g3-success-strong)]">Application installée ✓</span>;
  }

  return (
    <span className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={async () => {
          if (deferred) {
            await deferred.prompt();
            const choice = await deferred.userChoice;
            if (choice.outcome === "accepted") setInstalled(true);
            setDeferred(null);
            return;
          }
          const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
          setGuide(isIos ? "ios" : "generique");
        }}
        className="rounded-full bg-[var(--g3-gradient)] bg-[length:160%_100%] px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_22px_-8px_rgba(124,92,255,0.7)] transition hover:brightness-110"
      >
        Installer
      </button>
      {guide === "ios" && (
        <span className="max-w-[220px] text-right text-[11px] leading-4 text-[var(--g3-muted)]">
          Dans Safari : bouton Partager puis « Sur l&apos;écran d&apos;accueil ».
        </span>
      )}
      {guide === "generique" && (
        <span className="max-w-[220px] text-right text-[11px] leading-4 text-[var(--g3-muted)]">
          Menu du navigateur puis « Installer l&apos;application » ou « Ajouter à l&apos;écran d&apos;accueil ».
        </span>
      )}
    </span>
  );
}

const PLATFORMS = [
  {
    key: "android",
    name: "Android",
    note: "Application web installable (PWA)",
    icon: "M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.46 11.46 0 0 0-8.94 0L5.65 5.67c-.19-.29-.58-.38-.87-.2-.28.18-.37.54-.22.83L6.4 9.48A10.81 10.81 0 0 0 1 18h22a10.81 10.81 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z",
  },
  {
    key: "ios",
    name: "iPhone & iPad",
    note: "Application web installable (PWA)",
    icon: "M16.365 1.43c0 1.14-.47 2.2-1.23 3.01-.79.86-2.08 1.52-3.15 1.44-.14-1.1.43-2.27 1.19-3.06.84-.87 2.25-1.51 3.19-1.39zM20.94 17.1c-.57 1.3-.84 1.88-1.57 3.03-1.02 1.6-2.46 3.59-4.25 3.6-1.59.02-2-.99-4.16-.98-2.16.01-2.61 1-4.2.98-1.79-.02-3.16-1.82-4.18-3.42C.7 16.36.4 11.54 2.14 9.05c1.23-1.75 3.17-2.77 5-2.77 1.86 0 3.03 1 4.57 1 1.5 0 2.41-1 4.56-1 1.63 0 3.36.89 4.59 2.42-4.03 2.21-3.38 7.96.08 10.4z",
  },
  {
    key: "pc",
    name: "PC (Windows, Linux, macOS)",
    note: "Agent Live direct dans le navigateur — sans téléchargement",
    icon: "M3 5.5l7-.95v6.95H3V5.5zm0 13l7 .95V12.5H3v6zm8 1.08L21 21V12.5h-10v7.08zM11 3v7.5h10V3L11 4.42V3z",
  },
];

/**
 * Section « Chaque appareil, un seul Gen3ia » — le Web est la plateforme de
 * référence : l'Agent Live s'utilise directement dans le navigateur du PC
 * (partage d'écran natif), sans installer ni télécharger quoi que ce soit.
 */
export function AppDownloads() {
  return (
    <section aria-label="Applications Gen3ia" className="px-4 pb-20 sm:px-6">
      <div
        className="mx-auto max-w-6xl rounded-[36px] p-4 sm:p-6"
        style={{
          background:
            "linear-gradient(135deg, rgba(124,92,255,0.16) 0%, rgba(225,79,234,0.12) 34%, rgba(42,212,232,0.12) 68%, rgba(47,212,138,0.10) 100%)",
        }}
      >
        <div className="reveal rounded-[28px] border border-[var(--g3-border)] bg-[var(--g3-surface)]/90 p-7 backdrop-blur sm:p-10">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
            <div className="min-w-0">
              <p className="g3-eyebrow">Applications</p>
              <h2 className="mt-4 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight sm:text-4xl">
                Chaque appareil.
                <br />
                Un seul Gen3ia.
              </h2>
              <p className="mt-4 max-w-md text-sm leading-7 text-[var(--g3-muted)]">
                Installez l&apos;application web sur votre téléphone, et sur PC
                utilisez l&apos;Agent Live directement dans votre navigateur :
                rien à télécharger, rien à installer.
              </p>
            </div>
            <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
              {PLATFORMS.map((platform) => (
                <li
                  key={platform.key}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/70 p-4"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--g3-gradient)] bg-[length:160%_100%] text-white shadow-[0_8px_22px_-8px_rgba(124,92,255,0.7)]">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d={platform.icon} />
                      </svg>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-[var(--g3-text)]">{platform.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--g3-faint)]">{platform.note}</span>
                    </span>
                  </span>
                  {platform.key === "pc" ? (
                    <a
                      href="/live"
                      className="shrink-0 rounded-full border border-[rgba(148,153,255,0.3)] bg-white/[0.05] px-4 py-2 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[rgba(124,92,255,0.6)] hover:text-white"
                    >
                      Ouvrir
                    </a>
                  ) : (
                    <PwaInstallButton />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
