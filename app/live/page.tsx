import { headers } from "next/headers";

import { detectDeviceFromHeaders } from "@/lib/device/detect";

import { LiveDashboard } from "./live-dashboard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent Live",
};

/**
 * Page Agent Live — accessible SUR PC ET ANDROID (réouverture demandée
 * par le propriétaire : « l'agent live accessible via Android et PC »).
 *
 * it.52 (demande propriétaire : « activation depuis le Chat IA, live en
 * interne avec gen3 ») : l'ACTIVATION vit désormais dans le chat IA
 * (bouton « Agent Live » → panneau interne components/live/
 * live-interne-panel) ; cette page reste la surface de SUIVI HITL
 * (sessions, décisions, approbations, arrêt) sur le pipeline interne.
 *
 * Source de capture choisie à l'activation dans le chat :
 *  - PC (Windows/Linux/macOS) : partage d'écran natif (getDisplayMedia)
 *    — l'IA voit l'écran en direct ;
 *  - Android / iOS / tablette : CAMÉRA (avant/arrière, getUserMedia) —
 *    le partage d'écran n'existe pas sur ces navigateurs, la caméra est
 *    la source visuelle honnête équivalente.
 *
 * MOTEUR 100 % INTERNE : décisions rendues par le moteur de vision gen3
 * (lib/live/vision-decider) via les portes /api/live/sessions — AUCUNE
 * clé externe, AUCUN service tiers (l'ancien canal « Gemini Live » est
 * retiré).
 */
export default async function LivePage() {
  const device = detectDeviceFromHeaders(await headers());
  const sourceHint =
    device.isLiveCapable
      ? "Partage d'écran natif (getDisplayMedia) depuis le Chat IA."
      : "Mode caméra depuis le Chat IA : l'agent voit ce que votre appareil pointe (caméra avant/arrière).";

  return (
    <div className="min-h-full bg-[var(--g3-bg)] p-3 text-[var(--g3-text)] md:p-8">
      <div className="mx-auto max-w-6xl">
        <p className="mb-3 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-2.5 text-xs leading-5 text-[var(--g3-muted)] md:mb-5">
          <strong className="text-[var(--g3-text)]">Agent Live — {device.type === "mobile" ? "Android/iOS" : device.type === "tablet" ? "tablette" : "ordinateur"}.</strong>{" "}
          {sourceHint} Activation dans le Chat IA (bouton « Agent Live »), moteur interne gen3 — aucune clé externe.
        </p>
        <LiveDashboard />
      </div>
    </div>
  );
}
