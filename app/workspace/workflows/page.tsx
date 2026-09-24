import type { Metadata } from "next";

import { SectionHeader } from "@/components/shells/section-header";
import { WorkflowStudio } from "@/components/workflows/workflow-studio";

export const metadata: Metadata = {
  title: "Workflows",
  description: "Automatisez avec des graphes exécutables : agents, outils, conditions, validations humaines.",
};

export default function WorkflowsPage() {
  return (
    <div className="space-y-5">
      <SectionHeader
        title="Workflows"
        description="Graphes d'automatisation exécutables : agents du Studio, outils Gen3ia, conditions, transformations et validations humaines."
      />
      <WorkflowStudio />
    </div>
  );
}
