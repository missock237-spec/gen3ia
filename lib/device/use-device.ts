"use client";

import { useEffect, useState } from "react";

import { detectDevice, DESKTOP_APP_UA_FLAG, type DeviceInfo } from "./detect";

interface Gen3iaDesktopBridge {
  isGen3iaDesktop: boolean;
  version: string;
  platform: string;
}

interface IosNavigator extends Navigator {
  standalone?: boolean;
}

/**
 * Hook client de detection automatique d'appareils.
 *
 * Retourne `null` pendant le rendu serveur / la premiere peinture, puis la
 * detection complete cote client (afin d'eviter tout mismatch d'hydratation).
 * Combine : pont Electron (app PC), mode PWA installee, User-Agent et
 * Client Hints exposes par le navigateur.
 */
export function useDevice(): DeviceInfo | null {
  const [device, setDevice] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    const bridge = (window as unknown as { gen3iaDesktop?: Gen3iaDesktopBridge })
      .gen3iaDesktop;
    const isDesktopApp = bridge?.isGen3iaDesktop === true;
    const pwaStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (window.navigator as IosNavigator).standalone === true;

    // Le marqueur desktop renforce la detection serveur (proxy) qui lit deja
    // l'User-Agent de l'app PC ; le pont preload est la source la plus sure.
    const userAgent = isDesktopApp
      ? `${window.navigator.userAgent} ${DESKTOP_APP_UA_FLAG}/${bridge?.version ?? "1.0.0"}`
      : window.navigator.userAgent;

    const nav = window.navigator as Navigator & {
      userAgentData?: { mobile?: boolean; platform?: string };
    };

    // Reporte la mise a jour d'un tick (requestAnimationFrame) : evite un
    // rendu en cascade synchrone dans l'effet sans changer la detection.
    const raf = requestAnimationFrame(() => {
      setDevice(
        detectDevice({
          userAgent,
          mobileHint: nav.userAgentData?.mobile ? "?1" : null,
          platformHint: nav.userAgentData?.platform ?? null,
          desktopApp: isDesktopApp,
          pwaStandalone,
        }),
      );
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return device;
}
