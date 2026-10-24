import type { Metadata } from "next";

import { AutomationsConsole } from "@/components/automations/automations-console";

export const metadata: Metadata = {
  title: "Automatisations",
  description:
    "Espace Automatisations Gen3ia : créez vos agents dédiés et vos tâches planifiées récurrentes — veille, relances, rapports quotidiens. Chaque exécution est visible, relançable et arrêtable à tout moment.",
};

/**
 * Espace Automatisations — destination « Création d'agents » et espace des
 * tâches planifiées (restructuration des parcours) : les planifications
 * existaient côté API (/api/agents/schedules + cron) mais n'étaient plus
 * accessibles depuis une interface dédiée — restauration demandée.
 */
export default function AutomationsPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <AutomationsConsole />
    </div>
  );
}
