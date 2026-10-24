import type { Metadata } from "next";

import { LabConsole } from "@/components/lab/lab-console";

export const metadata: Metadata = {
  title: "Laboratoire de modèles",
  description:
    "Laboratoire de modèles Gen3ia : créez un projet d'entraînement, joignez vos datasets, générez un plan assisté par IA, lancez l'entraînement et suivez précision, pertes et modèles produits — précision mesurée, jamais simulée sans étiquette.",
};

/**
 * Laboratoire de modèles — destination « Entraînement de modèles » et
 * « Évaluation des modèles » de la page d'accueil (restructuration des
 * parcours). Le hachage (#entrainement, #evaluation, #modeles) pré-sélectionne
 * l'onglet : les liens externes conduisent directement à la bonne section.
 */
export default function LabPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <LabConsole />
    </div>
  );
}
