import type { Metadata } from "next";

import { IntegrationsWorkspace } from "@/components/integrations/integrations-workspace";

export const metadata: Metadata = {
  title: "Intégrations",
  description:
    "Connectez WhatsApp, Telegram, Slack, LinkedIn, X, Gmail, Google Agenda, Stripe et plus de 20 services externes à vos agents Gen3ia. Webhooks sortants et approbation depuis votre messagerie.",
};

export default function IntegrationsPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <IntegrationsWorkspace />
    </div>
  );
}
