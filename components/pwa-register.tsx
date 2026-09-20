"use client";

import { useEffect } from "react";

/**
 * Retire les anciens service workers qui pouvaient servir une page hors-ligne
 * ou des bundles périmés à la place du Studio courant.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    });
  }, []);

  return null;
}
