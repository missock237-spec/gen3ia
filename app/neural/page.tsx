import type { Metadata } from "next";

import ModulesGen3 from "@/components/neural/modules-gen3";
import { NeuralConsole } from "@/components/neural/neural-console";

export const metadata: Metadata = {
  title: "Cerveau IA Gen3 — Aurora OS V6",
  description:
    "Le cerveau de Gen3ia : réseau de neurones à spikes avec plasticité hebbienne et cortex langagier. Constellation synaptique en direct, conversation réelle, santé du noyau, atelier média local et entraînement supervisé sur le corpus du projet.",
};

export default function NeuralPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <NeuralConsole />
      <div className="mx-auto w-full max-w-6xl px-4 pb-8">
        <ModulesGen3 />
      </div>
    </div>
  );
}
