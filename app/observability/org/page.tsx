import type { Metadata } from "next";

import { OrgUsageConsole } from "@/components/observability/org-usage-console";

export const metadata: Metadata = {
  title: "Usage par organisation",
  description:
    "Usage agrégé de vos organisations Gen3ia : exécutions, coûts, tokens et adoption des agents, agrégés par agent, outil et jour — accès réservé aux membres (vérification serveur), données agrégées sans aucun contenu conversationnel.",
};

/**
 * Usage par organisation — it.51 (Task 43 du saas-roadmap §3).
 * La vue entreprise de l'observabilité : les exécutions des membres de
 * l'organisation, agrégées par agent / outil / jour, restituées par la
 * porte /api/observability/org (requireOrgContext — 404 uniforme si
 * l'appelant n'est pas membre). Jumeau entreprise de la vue personnelle
 * /observability.
 */
export default function OrgUsagePage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <OrgUsageConsole />
    </div>
  );
}
