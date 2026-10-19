import type { Metadata } from "next";

import LaboratoireMonde from "@/components/monde/laboratoire-monde";

/**
 * Le Monde — le simulateur universel des lois de la nature.
 *
 * Page publique : l'utilisateur décrit un phénomène physique en
 * français, le moteur l'interprète, résout les équations (RK4,
 * Crank-Nicolson, différences finies, Monte-Carlo…) et dessine la
 * physique en temps réel. Tout le calcul tourne dans le navigateur :
 * architecture « utilisateurs infinis », chaque client apporte sa
 * puissance de calcul.
 */
export const metadata: Metadata = {
  title: "Le Monde — l'IA qui simule les lois de la nature | Gen3ia",
  description:
    "Décrivez un phénomène physique en français : projectile, ondes, quantique, relativité, thermodynamique, fluides, équations différentielles — le moteur résout et dessine la physique en temps réel, dans votre navigateur.",
};

export default function PageMonde() {
  return <LaboratoireMonde />;
}
