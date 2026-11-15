import { describe, expect, it, vi } from "vitest";

import type { AIRequest } from "@/lib/ai/models";

import { createRng } from "./core/rng";
import { EspaceFiltreResonant } from "./core/resonant-space";
import { GenerateurAutoOscillation } from "./core/auto-oscillation";
import { NoyauCentralGen3 } from "./core/central-core";
import { ReseauNeuronalGen3 } from "./core/network";
import { CANAL_UTILISATEUR_IN } from "./core/types";
import { NeuralEngine } from "./engine";
import type { ResultatRechercheWeb } from "./recherche-web-pont";
import type { CortexLangagierGen3 } from "./generation/language";

/**
 * GARANTIE DE RÉPONSE — gen3 ne laisse JAMAIS un utilisateur sans réponse.
 *
 * Chaîne réelle du moteur vérifiée ici (moteur minimal, cortex maître du
 * cas) : quand la matière interne est insuffisante (aucune paire cortex →
 * repli décodeur générique), le moteur déclenche la recherche web AUTOMATIQUE
 * (injectée) et répond soit avec les sources citées, soit honnêtement —
 * jamais un silence, jamais un « je ne sais pas » sec.
 */

function monterMoteur(injecteur?: (requete: string) => Promise<ResultatRechercheWeb[] | null>): {
  engine: NeuralEngine;
} {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [0, 1, 2]);
  espace.registerOutputPool("GENERER_IMAGE", [3, 4, 5]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);

  // CORTEX MAÎTRE DU CAS : null = aucune matière (filet déclenché) ;
  // une longue réponse bien appariée = savoir suffisant (filet silencieux).
  const cortex = {
    repondre: (prompt: string) => {
      if (prompt.includes("requête-sans-matière")) return null;
      return {
        texte:
          "Réponse riche du cortex : voici l'explication complète et détaillée de votre demande, avec assez de matière pour couvrir tous les points utiles sans filet.",
        source: "corpus" as const,
        theme: "test",
        score: 0.92,
        cle: "cle-test",
      };
    },
  } as unknown as CortexLangagierGen3;

  return { engine: new NeuralEngine(noyau, espace, cortex, undefined, undefined, undefined, undefined, undefined, injecteur) };
}

function requete(message: string): AIRequest {
  return { messages: [{ role: "user", content: message }] };
}

describe("garantie de réponse — recherche web automatique du moteur", () => {
  it("savoir insuffisant + injecteur → réponse fondée sur les sources web citées", async () => {
    const injecteur = vi.fn(async (requete_: string) => {
      expect(requete_).toContain("requête-sans-matière");
      return [
        {
          titre: "Documentation officielle de la requête-sans-matière",
          url: "https://example.org/doc",
          extrait: "La requête-sans-matière désigne un cas d'usage documenté ici en détail.",
        },
      ] satisfies ResultatRechercheWeb[];
    });
    const { engine } = monterMoteur(injecteur);

    const reponse = await engine.generate(requete("requête-sans-matière inconnue de mon corpus"));
    expect(injecteur).toHaveBeenCalledTimes(1);
    expect(reponse.text).toContain("recherche web");
    expect(reponse.text).toContain("https://example.org/doc");
  });

  it("recherche web échouée → repli honnête explicite, réponse TOUJOURS non vide", async () => {
    const injecteur = vi.fn(async () => {
      throw new Error("réseau indisponible");
    });
    const { engine } = monterMoteur(injecteur);

    const reponse = await engine.generate(requete("requête-sans-matière hors réseau"));
    expect(injecteur).toHaveBeenCalledTimes(1);
    expect(reponse.text.length).toBeGreaterThan(150);
    expect(reponse.text).toContain("Recherche web");
    expect(reponse.text).toContain("reformulez");
  });

  it("résultats non pertinents (aucun recouvrement) → repli honnête, pas de matière inventée", async () => {
    const injecteur = vi.fn(async () => [
      { titre: "Recette de tarte aux pommes", url: "https://example.org/tarte", extrait: "Étaler la pâte." },
    ]);
    const { engine } = monterMoteur(injecteur);

    const reponse = await engine.generate(requete("requête-sans-matière sur le protocole Zénon"));
    expect(injecteur).toHaveBeenCalledTimes(1);
    expect(reponse.text).not.toContain("tarte");
    expect(reponse.text.length).toBeGreaterThan(150);
  });

  it("savoir suffisant (cortex bien apparié) → l'injecteur n'est PAS appelé", async () => {
    const injecteur = vi.fn(async () => []);
    const { engine } = monterMoteur(injecteur);

    const reponse = await engine.generate(requete("question banale couverte par le cortex"));
    expect(injecteur).not.toHaveBeenCalled();
    expect(reponse.text).toContain("Réponse riche du cortex");
  });

  it("sans injecteur (intégrations minimales) → comportement historique inchangé", async () => {
    const { engine } = monterMoteur(undefined);
    const reponse = await engine.generate(requete("requête-sans-matière sans filet"));
    expect(reponse.text.length).toBeGreaterThan(0);
    // Aucune mention d'une recherche non exécutée : le moteur répond comme avant.
    expect(reponse.text).not.toContain("recherche web");
  });
});
