"use client";

import { useEffect } from "react";

import { useSessionAvailable } from "@/lib/firebase/auth-client";
import {
  désinstallerAgentGen3,
  installerAgentGen3,
} from "@/lib/essaim-media/agent-client";

/**
 * AGENT GEN3 — installation AUTOMATIQUE à l'inscription / à la connexion.
 *
 * Dès qu'une session est disponible (montage sur n'importe quelle page,
 * retour d'OAuth, création de compte), le petit agent gen3 se télécharge
 * dans le cache du navigateur (Service Worker /gen3-agent/) et relie
 * l'appareil à l'IA centrale par ondes (battements + canal SSE). À la
 * déconnexion, il part proprement (onde d'adieu).
 *
 * Rendu : null — l'agent est invisible, son panneau vit dans /lab.
 */
export function AgentGen3Register() {
  const session = useSessionAvailable();

  useEffect(() => {
    if (session === true) {
      void installerAgentGen3();
    } else if (session === false) {
      void désinstallerAgentGen3();
    }
    return undefined;
  }, [session]);

  // Retour d'onglet : re-battement immédiat (l'onde de vie peut s'être
  // tue pendant la mise en veille — la sentinelle centrale a pu relancer
  // des parts ; on reprend du service au plus vite).
  useEffect(() => {
    const reprise = (): void => {
      if (document.visibilityState === "visible" && session === true) {
        void installerAgentGen3();
      }
    };
    document.addEventListener("visibilitychange", reprise);
    return () => document.removeEventListener("visibilitychange", reprise);
  }, [session]);

  return null;
}
