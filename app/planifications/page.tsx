import type { Metadata } from "next";

import { RedirectRoute } from "@/components/data/redirect-route";

export const metadata: Metadata = {
  title: "Planifications — redirection",
  description:
    "Les tâches planifiées automatisées vivent désormais dans l'Espace Automatisations : /automations#planifications (agents + planifications dans un même espace de travail).",
};

/**
 * REDIRECTION (restructuration des parcours) : la surface /planifications
 * est FONDUE dans l'Espace Automatisations comme onglet dédié. Cette page
 * conserve la compatibilité des anciens liens (bookmarks, chat IA) en
 * renvoyant vers /automations#planifications — un seul parcours
 * identifiable pour « Création d'agents » et « Tâches planifiées ».
 */
export default function PlanificationsRedirectPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <RedirectRoute
        href="/automations#planifications"
        label="Ouvrir l'Espace Automatisations"
        texte="Les planifications ont rejoint l'Espace Automatisations (onglet Planifications). Redirection en cours…"
      />
    </div>
  );
}
