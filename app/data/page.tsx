import type { Metadata } from "next";

import { DataConsole } from "@/components/data/data-console";

export const metadata: Metadata = {
  title: "Centre de données",
  description:
    "Centre de données Gen3ia : importez vos datasets (csv, json, jsonl, txt), téléchargez depuis Hugging Face et Kaggle, vérifiez la validation réelle (stats, doublons, PII) avant tout entraînement.",
};

/**
 * Centre de données — destination « Gestion des datasets » de la page
 * d'accueil (restructuration des parcours). Un seul espace pour voir,
 * importer et valider les données qui alimentent le Laboratoire de modèles.
 */
export default function DataPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <DataConsole />
    </div>
  );
}
