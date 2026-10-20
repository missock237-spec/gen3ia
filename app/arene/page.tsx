import type { Metadata } from "next";

import AreneOndes from "@/components/ondes/arene-ondes";

/**
 * Arène d'interférence — le pont entre les IA actuelles et le monde
 * d'ondes : deux IA (professeur et élève, ou deux modèles d'utilisateurs)
 * traduisent leurs réponses en ondes, les font s'interférer, et la
 * physique juge chaque idée. L'élève ressort entraîné (distillation par
 * ondes), le modèle amélioré est exportable. Page publique : la session
 * se joue entièrement dans le navigateur, sans compte ni serveur.
 */
export const metadata: Metadata = {
  title: "Arène d'interférence — les IA s'entraînent par ondes | Gen3ia",
  description:
    "Vos modèles Gen3 entrent dans l'arène : leurs réponses deviennent des ondes sur une grille d'oscillateurs, la résonance constructive valide et l'interférence destructive corrige — l'accélérateur de particules pour IA, entièrement dans votre navigateur.",
};

export default function PageArene() {
  return <AreneOndes />;
}
