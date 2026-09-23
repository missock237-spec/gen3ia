import type { Metadata } from "next";

import { MemoryWorkspace } from "@/components/memory/memory-workspace";

export const metadata: Metadata = {
  title: "Mémoire permanente — GEN3IA",
  description:
    "Stockez durablement les informations clés et les documents (jusqu'à 100 Mo par fichier, 10 fichiers par lot) que vos agents GEN3IA retrouveront à chaque mission.",
};

export default function MemoryPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-neutral-900">
      <MemoryWorkspace />
    </div>
  );
}
