import type { Metadata } from "next";

import LaboratoireOndes from "@/components/ondes/laboratoire-ondes";
import PanneauEntrainementRPIA from "@/components/ondes/panneau-entrainement-rpia";

/**
 * Ondes W-DNN — le laboratoire d'inférence par ondes neuronales
 * distribuées : visualisation temps réel du champ (WebGPU), essaim P2P
 * (WebRTC), écriture progressive de l'IA et optimisation évolutive.
 * Le panneau d'entraînement RPIA ajoute la facette APPRENTISSAGE :
 * la requête apprend à résonner, le cerveau reçoit l'énergie, la
 * synthèse acoustique s'écoute. Page publique : la démonstration du
 * moteur fonctionne sans compte, le cortex Gen3 complet s'active à la
 * connexion.
 */
export const metadata: Metadata = {
  title: "Ondes W-DNN — l'IA qui pense en ondes | Gen3ia",
  description:
    "Chat IA nouvelle génération : ton prompt devient une onde propagée sur le GPU, l'IA écrit mot à mot au fil de la résonance, et les navigateurs connectés forment un essaim P2P d'oscillateurs couplés.",
};

export default function PageOndes() {
  return (
    <div className="flex flex-col gap-6">
      <PanneauEntrainementRPIA />
      <LaboratoireOndes />
    </div>
  );
}
