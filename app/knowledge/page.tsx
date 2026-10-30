import type { Metadata } from "next";

import { KnowledgeConsole } from "@/components/knowledge/knowledge-console";

export const metadata: Metadata = {
  title: "Espace connaissances",
  description:
    "Knowledge Spaces Gen3ia : importez des documents réels (fichiers txt/md/csv/json/html/docx ou pages web) dans la base RAG de vos projets — extraction, découpage et indexation côté serveur, consultation par l'agent via knowledge.search.",
};

/**
 * Espace connaissances — Knowledge Spaces (LOT 6 du plan plateforme).
 * Un seul espace pour alimenter la bibliothèque RAG d'un projet : les
 * documents importés ici sont extraits, découpés en fragments et indexés,
 * puis consultés par les agents du projet via l'outil knowledge.search.
 */
export default function KnowledgePage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <KnowledgeConsole />
    </div>
  );
}
