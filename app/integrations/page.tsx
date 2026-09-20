import type { Metadata } from "next";

import { IntegrationsWorkspace } from "@/components/integrations/integrations-workspace";

export const metadata: Metadata = {
  title: "Intégrations — GEN3IA",
  description:
    "Connectez WhatsApp, Telegram, Slack, LinkedIn, X, Gmail, Google Agenda, Stripe et plus de 20 services externes à vos agents GEN3IA. Webhooks sortants et approbation depuis votre messagerie.",
};

export default function IntegrationsPage() {
  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900">
      <IntegrationsWorkspace />
    </div>
  );
}
