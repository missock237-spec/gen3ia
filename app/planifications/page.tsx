import type { Metadata } from "next";

import { PlanificationsWorkspace } from "@/components/planifications/planifications-workspace";

export const metadata: Metadata = {
  title: "Planifications — tâches automatisées",
  description:
    "Programmez vos agents Gen3ia : exécution récurrente (fenêtre hebdomadaire), ponctuelle (one-shot), veille RSS/web ou déclenchement webhook. Historique d'exécution et résultats en direct.",
};

export default function PlanificationsPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <PlanificationsWorkspace />
    </div>
  );
}
