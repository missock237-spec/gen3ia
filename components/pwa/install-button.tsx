"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Window iOS : `navigator.standalone` n'existe que sur Safari (indéfini ailleurs). */
interface IosWindow extends Window {
  navigator: Navigator & { standalone?: boolean };
}

/** Media query du mode application installée (manifest display: standalone). */
const STANDALONE_QUERY = "(display-mode: standalone)";

/**
 * Détecte si la page tourne déjà comme application installée :
 * `navigator.standalone` (iOS Safari) ou display-mode: standalone.
 */
function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // navigator.standalone (iOS Safari) : true uniquement dans l'app installée.
  const { navigator } = window as IosWindow;
  if (navigator.standalone === true) return true;
  return window.matchMedia?.(STANDALONE_QUERY).matches === true;
}

/**
 * État réactif « application installée » — partagé par le bouton
 * d'installation et la section Paramètres.
 *
 * Sources combinées (le bouton ne réapparaît jamais en mode standalone) :
 * - détection initiale : navigator.standalone (iOS) OU display-mode: standalone ;
 * - listener `change` sur matchMedia : passage web → app sans rechargement ;
 * - événement `appinstalled` : installation acceptée depuis le prompt natif.
 */
export function useStandaloneInstalled(): boolean {
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onInstalled = () => setInstalled(true);
    if (detectStandalone()) setInstalled(true);

    const modeQuery = window.matchMedia(STANDALONE_QUERY);
    const onModeChange = (event: MediaQueryListEvent) => {
      // Un seul sens : web → installée (pas de réaffichage du bouton).
      if (event.matches) setInstalled(true);
    };
    modeQuery.addEventListener("change", onModeChange);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      modeQuery.removeEventListener("change", onModeChange);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return installed;
}

/**
 * Bouton d'installation PWA (Android / Chrome / Edge).
 * Utilise l'événement natif beforeinstallprompt ; si indisponible
 * (iOS, navigateur non compatible), affiche un guide court.
 *
 * Extrait de components/home/app-downloads.tsx (Task 99-c) pour servir
 * aussi la section « Application » des Paramètres — `align="start"`
 * passe la pile bouton + guide en alignement à gauche (vitrine : fin).
 */
export function PwaInstallButton({ align = "end" }: { align?: "start" | "end" }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [guide, setGuide] = useState<null | "ios" | "generique">(null);
  const installed = useStandaloneInstalled();

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (installed) {
    return <span className="text-xs font-semibold text-[var(--g3-success-strong)]">Application installée ✓</span>;
  }

  const stackAlign = align === "start" ? "items-start" : "items-end";
  const guideAlign = align === "start" ? "text-left" : "text-right";

  return (
    <span className={`flex flex-col gap-1.5 ${stackAlign}`}>
      <button
        type="button"
        onClick={async () => {
          if (deferred) {
            await deferred.prompt();
            const choice = await deferred.userChoice;
            if (choice.outcome === "accepted") {
              // `appinstalled` n'est pas émis par tous les navigateurs
              // après un prompt programmatique : on aligne l'état ici.
              window.dispatchEvent(new Event("appinstalled"));
            }
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
        <span className={`max-w-[220px] text-[11px] leading-4 text-[var(--g3-muted)] ${guideAlign}`}>
          Dans Safari : bouton Partager puis « Sur l&apos;écran d&apos;accueil ».
        </span>
      )}
      {guide === "generique" && (
        <span className={`max-w-[220px] text-[11px] leading-4 text-[var(--g3-muted)] ${guideAlign}`}>
          Menu du navigateur puis « Installer l&apos;application » ou « Ajouter à l&apos;écran d&apos;accueil ».
        </span>
      )}
    </span>
  );
}
