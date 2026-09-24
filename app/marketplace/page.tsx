"use client";

import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { MarketplaceHub } from "@/components/marketplace/marketplace-hub";
import { useSessionAvailable } from "@/lib/firebase/auth-client";

export default function MarketplacePage() {
  // Session Firebase OU cookie de session serveur : l'une des deux suffit
  // pour parcourir, acheter et installer des extensions.
  const sessionDisponible = useSessionAvailable();

  if (sessionDisponible !== true) {
    return (
      <FeatureAuthGate
        feature="Marketplace Gen3ia"
        description="Connectez-vous pour découvrir, acheter, installer et gérer les extensions de vos agents."
      >
        <span />
      </FeatureAuthGate>
    );
  }

  return (
    <div className="min-h-full bg-[var(--g3-bg)]">
      <div className="mx-auto max-w-[1480px] px-3 pt-3 sm:px-5 lg:px-7">
      </div>
      <MarketplaceHub />
    </div>
  );
}
