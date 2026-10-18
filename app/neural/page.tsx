import type { Metadata } from "next";

import { NeuralConsole } from "@/components/neural/neural-console";

export const metadata: Metadata = {
  title: "Console neuronale Gen3",
  description:
    "Testez le système neuronal Gen3 à spikes : conversation par cycles réels, état du cerveau, entraînement supervisé sur le corpus du projet et reset complet.",
};

export default function NeuralPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <NeuralConsole />
    </div>
  );
}
