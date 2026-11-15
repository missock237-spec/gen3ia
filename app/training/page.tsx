import type { Metadata } from "next";

import { TrainingStudio } from "@/components/training/studio-workspace";

export const metadata: Metadata = {
  title: "Studio d'entraînement IA",
  description:
    "Créez des projets d'entraînement, importez vos datasets (upload, Hugging Face, Kaggle), analysez-les avec l'IA, lancez des tâches GPU réelles et suivez rapports, métriques par époque et lineage des données.",
};

export default function TrainingPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <TrainingStudio />
    </div>
  );
}
