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
 * Source de capture adaptée par le panneau Gemini Live selon l'appareil :
 *  - PC (Windows/Linux/macOS) : partage d'écran natif (getDisplayMedia)
 *    + micro — l'IA voit l'écran en direct ;
 *  - Android / iOS / tablette : CAMÉRA (avant/arrière, getUserMedia) +
 *    micro — le partage d'écran n'existe pas sur ces navigateurs, la
 *    caméra est la source visuelle honnête équivalente.
 *
 * Le tableau de bord HITL (sessions, frames, décisions) fonctionne
 * identiquement : l'API /api/live/sessions accepte désormais tous les
 * appareils (garde PC-only retiré).
 */
export default async function LivePage() {
  const device = detectDeviceFromHeaders(await headers());
  const sourceHint =
    device.isLiveCapable
      ? "Partage d'écran natif (getDisplayMedia) + micro."
      : "Mode caméra : l'IA voit ce que votre appareil pointe (caméra avant/arrière) et vous entend.";

  return (
    <div className="min-h-full bg-[var(--g3-bg)] p-3 text-[var(--g3-text)] md:p-8">
      <div className="mx-auto max-w-6xl">
        <p className="mb-3 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-2.5 text-xs leading-5 text-[var(--g3-muted)] md:mb-5">
          <strong className="text-[var(--g3-text)]">Agent Live — {device.type === "mobile" ? "Android/iOS" : device.type === "tablet" ? "tablette" : "ordinateur"}.</strong>{" "}
          {sourceHint} Votre clé API Gemini reste dans votre navigateur (sessionStorage).
        </p>
        <LiveDashboard />
      </div>
    </div>
  );
}
