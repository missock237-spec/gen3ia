import type { Metadata } from "next";

import { KnowledgePanel } from "@/components/knowledge/knowledge-panel";
import { SectionHeader } from "@/components/shells/section-header";

export const metadata: Metadata = {
  title: "Knowledge",
  description: "Bases de connaissances RAG : importez vos documents et pages web, vos agents s'y appuient automatiquement.",
};

export default function KnowledgePage() {
  return (
    <div className="space-y-5">
      <SectionHeader
        title="Knowledge"
        description="Vos documents et pages web, indexés pour vos agents : chunks, embeddings et recherche vectorielle par projet."
      />
      <KnowledgePanel />
    </div>
  );
}
