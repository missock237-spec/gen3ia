"use client";

import { MissionComposer } from "@/components/workspace/mission-composer";
import { SectionHeader } from "@/components/shells/section-header";

/**
 * /studio/create — composer une nouvelle mission avec suggestions
 * contextuelles. Les modules métier (Marketing, Ventes, RH, Documents,
 * Conformité, Opérations, Finance, Automatisations) sont présentés comme
 * modèles et filtres, conformément à l'architecture à 3 espaces.
 */
export default function CreatePage() {
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL / CRÉER"
        title="Composer"
        highlight="une mission"
        description="Choisissez un modèle métier ou partez d'un objectif libre : Gen3ia planifie les étapes, mobilise les bons connecteurs et vous demande les validations nécessaires. Les fonctions métier restent accessibles ici, sans surcharger la navigation."
        breadcrumbs={[{ label: "Missions", href: "/studio" }, { label: "Créer" }]}
      />
      <MissionComposer />
    </div>
  );
}
