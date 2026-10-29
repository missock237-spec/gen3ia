import type { Metadata } from "next";

import { ExtensionsAccount } from "@/components/extensions/account-view";

export const metadata: Metadata = {
  title: "Mes extensions",
  description:
    "Vos extensions Gen3ia : installations actives, historique d'achats (canal réel), licences et usage détaillé de chaque extension installée.",
};

export default function ExtensionsPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <ExtensionsAccount />
    </div>
  );
}
