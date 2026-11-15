import { describe, it, expect, afterAll } from "vitest";

import { lancerEntrainement, getDernierJob } from "./job";
import { getNeuralRuntime, resetBrain } from "../runtime";

/**
 * TEST D'INTÉGRATION DU JOB D'ENTRAÎNEMENT — boucle complète sur le corpus
 * réel du dépôt (public/llms*.txt + amorçage canonique), puis génération
 * neuronale via le moteur. Vérifie que le job progresse honnêtement et que
 * la réponse générée respecte le contrat AIResponse.
 */
describe("Job d'entraînement neuronal (E2E)", () => {
  it("entraîne le cerveau sur le corpus du projet et produit un rapport réel", async () => {
    const job = lancerEntrainement({
      epochs: 2,
      maxParLabel: 6,
      maxTotal: 80,
    });

    expect(job.status).toBe("en_cours");
    expect(job.source).toBe("corpus");

    // Attend la fin du job asynchrone (timeout large, corpus volontairement
    // petit via maxTotal pour garder le test rapide).
    const debut = Date.now();
    while (Date.now() - debut < 60_000) {
      const courant = getDernierJob();
      if (courant && courant.status !== "en_cours") break;
      await new Promise((resoudre) => setTimeout(resoudre, 100));
    }

    const final = getDernierJob();
    expect(final).not.toBeNull();
    expect(final!.status).toBe("termine");
    expect(final!.rapport).toBeDefined();
    expect(final!.rapport!.epochs).toBe(2);
    expect(final!.rapport!.samples).toBeGreaterThan(0);
    expect(final!.rapport!.history).toHaveLength(2);
    expect(final!.rapport!.dureeMs).toBeGreaterThan(0);
    // Au moins les 54 exemples canoniques sont dans le jeu.
    expect(final!.nbEchantillons).toBeGreaterThanOrEqual(54);
  }, 90_000);

  it("le moteur génère une réponse honnête conforme au contrat AIResponse", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [
        { role: "user", content: "Bonjour, peux-tu me générer une image de chat ?" },
      ],
    });

    expect(typeof reponse.text).toBe("string");
    expect(reponse.text.length).toBeGreaterThan(10);
    expect(reponse.provider).toBe("gen3-snn");
    expect(reponse.model).toBe("gen3-snn-v1");
    expect(reponse.usage.totalTokens).toBeGreaterThan(0);
    expect(reponse.latencyMs).toBeGreaterThanOrEqual(0);
    // L'intention détectée est reportée honnêtement dans raw.
    const raw = reponse.raw as { intention?: string; resonances?: Record<string, number> };
    expect(raw).toBeDefined();
    expect(raw.intention).toBeDefined();
  });

  afterAll(() => {
    // Nettoyage : le test E2E a réellement persisté un cerveau entraîné sur le
    // petit jeu — on repart d'un état vierge pour ne pas polluer les runs
    // suivants (le fichier var/neural/brain-v1.json est purgé).
    resetBrain();
  });
});
