/**
 * GARDE DE CÂBLAGE — MOTEUR × COMPARTIMENTS CALCULABLES (it.114) :
 * les requêtes de calcul / simulation reçoivent une réponse CALCULÉE par
 * l'organe du cerveau (provenance déclarée dans raw.langage.source), et une
 * question de connaissance suit EXACTEMENT le chemin historique (zéro
 * régression : la délégation reste la règle quand aucun compartiment n'est
 * concerné).
 */
import { afterAll, describe, expect, it } from "vitest";

import { getNeuralRuntime, resetBrain } from "../runtime";

interface RawLangage {
  langage?: { source?: string; theme?: string | null };
}

describe("NeuralEngine × compartiments calculables", () => {
  afterAll(() => {
    resetBrain();
  });

  it("un calcul posé en français est résolu par le compartiment math", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "Calcule 17*23" }],
    });
    const raw = reponse.raw as RawLangage;
    expect(raw.langage?.source).toBe("compartiment_math");
    expect(reponse.text).toContain("391");
    expect(reponse.text).toContain("Étapes du calcul");
  });

  it("une question de sciences est simulée par le monde virtuel", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [
        { role: "user", content: "projectile lancé à 20 m/s avec un angle de 45 degrés" },
      ],
    });
    const raw = reponse.raw as RawLangage;
    expect(raw.langage?.source).toBe("compartiment_monde");
    expect(reponse.text).toContain("Compartiment sciences");
  });

  it("une commande explicite est exécutée par le terminal virtuel", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "js 2**10" }],
    });
    const raw = reponse.raw as RawLangage;
    expect(raw.langage?.source).toBe("compartiment_terminal");
    expect(reponse.text).toBe("1024");
  });

  it("une question de connaissance suit le chemin historique (zéro régression)", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "Bonjour, présente-toi brièvement." }],
    });
    const raw = reponse.raw as RawLangage;
    // Aucun compartiment ne doit capter une question de connaissance :
    // le cortex (corpus) ou le décodeur répondent, comme avant it.114.
    expect(raw.langage?.source).not.toMatch(/^compartiment_/);
  });

  it("les compartiments sont exposés dans le runtime (API + Studio)", () => {
    const runtime = getNeuralRuntime();
    expect(runtime.compartiments.math.resoudreProbleme("2+2").valeur).toBe(4);
    expect(runtime.compartiments.monde.capacites().length).toBeGreaterThan(0);
    expect(runtime.compartiments.terminal.executerCommande("aide").exitCode).toBe(0);
    expect(runtime.compartiments.orchestrateur.statistiques().total).toBeGreaterThanOrEqual(0);
    expect(runtime.compartiments.memoireDomaines.statistiques().compartiments).toBe(133);
  });
});
