import type { Metadata } from "next";

import { BusinessDashboard } from "@/components/business/dashboard";

export const metadata: Metadata = {
  title: "Business",
  description:
    "Modules métier Gen3ia : impayés, trésorerie, formations, maintenance, congés, conformité RGPD, onboarding, contrats, landing pages, kits webinar et automatisations — indicateurs calculés par les moteurs serveur, tables des enregistrements récents.",
};

export default function BusinessPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <BusinessDashboard />
    </div>
  );
}
