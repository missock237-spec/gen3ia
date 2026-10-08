import { headers } from "next/headers";

import { PcOnlyNotice } from "@/components/pc-only-notice";
import { detectDeviceFromHeaders } from "@/lib/device/detect";

import { VoiceLiveDashboard } from "./voice-live-dashboard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Live Voix — GEN3IA",
};

/**
 * Page Live Voix — réservée aux ordinateurs (contrat Task 110-0) : la
 * conversation vocale repose sur le micro, l'AudioWorklet et la lecture
 * audio du navigateur de bureau.
 *
 * Double protection, même pattern que app/live/page.tsx (agent Live) :
 * 1. Serveur : la détection d'appareils (headers posés par le proxy, repli
 *    sur l'User-Agent brut) bloque mobile et tablette ici même.
 * 2. API : POST /api/live/voice/session refuse aussi tout appareil non
 *    desktop (garde LIVE_PC_ONLY de la Task 110-a).
 */
export default async function LiveVoixPage() {
  const device = detectDeviceFromHeaders(await headers());

  if (!device.isLiveCapable) {
    return <PcOnlyNotice deviceType={device.type} />;
  }

  return (
    <div className="min-h-full bg-[var(--g3-bg)] p-5 text-[var(--g3-text)] md:p-8">
      <div className="mx-auto max-w-3xl">
        <VoiceLiveDashboard />
      </div>
    </div>
  );
}
