import { afterEach, describe, expect, it } from "vitest";

import { configurerChargeursGen3Local, gen3LocalProvider } from "./gen3-local";
import { CortexLangagierGen3 } from "@/lib/neural/generation/language";

/* ------------------------------------------------------------------ */
/* Fournisseur GEN3 LOCAL — l'entraînement par Gen doit être RÉEL :     */
/* métriques mesurées (pas simulées), artefact = vrai modèle            */
/* réimportable qui répond aux questions apprises.                      */
/* ------------------------------------------------------------------ */

const DATASET = JSON.stringify([
  { question: "Quel est le fruit préféré de la plateforme ?", response: "La mangue mûre, sans hésitation." },
  { question: "Qui développe ce logiciel ?", response: "L'équipe Gen3ia." },
  { question: "Quelle est la couleur du logo ?", response: "Un vert électrique sur fond sombre." },
  { question: "Comment se nomme le moteur neuronal ?", response: "gen3-snn." },
  { question: "Quelle année la plateforme a-t-elle été lancée ?", response: "En 2025." },
  { question: "Quel langage utilise le backend ?", response: "TypeScript, avec Next.js." },
  { question: "Où sont stockées les données ?", response: "Dans le stockage objet permanent de l'utilisateur." },
  { question: "Comment s'appelle la mémoire à court terme ?", response: "L'hippocampe." },
]);

function chargeursMemoire() {
  const fichiers = new Map<string, string>();
  fichiers.set("mem://train.json", DATASET);
  return {
    fichiers,
    chargerDataset: async (key: string) => {
      const contenu = fichiers.get(key);
      if (contenu === undefined) throw new Error(`Dataset introuvable : ${key}`);
      return contenu;
    },
    archiverModele: async (key: string, corps: string) => {
      fichiers.set(key, corps);
      return Buffer.byteLength(corps, "utf-8");
    },
  };
}

function payload(datasets: Array<{ storageKey: string; split: string; format: string }>) {
  return {
    jobId: "job-test-gen3",
    engineId: "gen3-native",
    method: "finetune",
    parameters: { epochs: 3, testRatio: 0.25 } as Record<string, unknown>,
    baseModel: { kind: "catalog" as const, ref: "gen3-snn-cortex" },
    datasets,
  };
}

async function attendreStatutFini(externalId: string) {
  for (let i = 0; i < 200; i += 1) {
    const etat = await gen3LocalProvider.status(externalId);
    if (etat.status === "completed" || etat.status === "failed") return etat;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("L'entraînement n'a pas fini dans le temps imparti");
}

afterEach(() => {
  configurerChargeursGen3Local(null);
});

describe("gen3LocalProvider", () => {
  it("déclare son périmètre (gen3-native uniquement) et simulated=false", async () => {
    expect(gen3LocalProvider.engines).toEqual(["gen3-native"]);
    const caps = await gen3LocalProvider.capabilities();
    expect(caps.simulated).toBe(false);
    expect(caps.gpus.some((g) => g.available)).toBe(true);
  });

  it("entraîne RÉELLEMENT : tâche complétée, métriques mesurées, artefact réimportable", async () => {
    const memoire = chargeursMemoire();
    configurerChargeursGen3Local(memoire);
    const { externalId } = await gen3LocalProvider.submit(payload([{ storageKey: "mem://train.json", split: "train", format: "json" }]));

    const etat = await attendreStatutFini(externalId);
    expect(etat.status).toBe("completed");
    expect(etat.progressPercent).toBe(100);
    expect(etat.metrics.pairesApprises).toBeGreaterThan(0);
    expect(typeof etat.metrics.precisionTrain).toBe("number");
    expect(etat.metrics.vocabulaire).toBeGreaterThan(0);
    // Époques réellement déroulées et mesurées.
    expect(etat.epochsDone).toBe(3);
    expect(etat.artifacts).toHaveLength(1);

    // L'artefact est un VRAI modèle Gen3 : on le réimporte et il répond.
    const cle = etat.artifacts[0].storageKey;
    const contenu = memoire.fichiers.get(cle);
    expect(contenu).toBeDefined();
    const artefact = JSON.parse(contenu!) as {
      format: string;
      metriques: { precisionTest: number | null };
      modele: { pairesPersonnalisees: Array<{ motif: string; reponse: string }> };
    };
    expect(artefact.format).toBe("gen3-language-model");
    expect(artefact.modele.pairesPersonnalisees.length).toBeGreaterThan(0);

    const modele = new CortexLangagierGen3();
    modele.importerEtat(artefact.modele);
    const reponse = modele.repondre("Comment se nomme le moteur neuronal ?");
    expect(reponse?.texte).toBe("gen3-snn.");
  });

  it("échoue honnêtement sur un dataset sans paires exploitables", async () => {
    const memoire = chargeursMemoire();
    memoire.fichiers.set("mem://vide.json", JSON.stringify([{ rien: "ici" }]));
    configurerChargeursGen3Local(memoire);
    const { externalId } = await gen3LocalProvider.submit(payload([{ storageKey: "mem://vide.json", split: "train", format: "json" }]));
    const etat = await attendreStatutFini(externalId);
    expect(etat.status).toBe("failed");
    expect(etat.error).toContain("paire");
    expect(etat.artifacts).toHaveLength(0);
  });

  it("échoue honnêtement si le dataset du split train est introuvable", async () => {
    configurerChargeursGen3Local(chargeursMemoire());
    const { externalId } = await gen3LocalProvider.submit(payload([{ storageKey: "mem://absent.json", split: "train", format: "json" }]));
    const etat = await attendreStatutFini(externalId);
    expect(etat.status).toBe("failed");
    expect(etat.error).toContain("introuvable");
  });

  it("consigne des journaux réels (jamais de préfixe [SIMULATION])", async () => {
    const memoire = chargeursMemoire();
    configurerChargeursGen3Local(memoire);
    const { externalId } = await gen3LocalProvider.submit(payload([{ storageKey: "mem://train.json", split: "train", format: "json" }]));
    const etat = await attendreStatutFini(externalId);
    expect(etat.logs.length).toBeGreaterThan(2);
    for (const ligne of etat.logs) expect(ligne.message).not.toContain("[SIMULATION]");
    expect(etat.logs.some((l) => l.message.includes("précision train"))).toBe(true);
  });

  it("annule une session en cours (pas de statut complété après annulation)", async () => {
    const memoire = chargeursMemoire();
    memoire.fichiers.set("mem://gros.jsonl", [...Array.from({ length: 200 }, (_, i) => JSON.stringify({ question: `q${i} détail varié ${i}`, response: `réponse longue ${i} contextuelle` }))].join("\n"));
    configurerChargeursGen3Local(memoire);
    const { externalId } = await gen3LocalProvider.submit(payload([{ storageKey: "mem://gros.jsonl", split: "train", format: "jsonl" }]));
    await gen3LocalProvider.cancel(externalId);
    const etat = await gen3LocalProvider.status(externalId);
    // Après annulation : jamais « completed » (soit failed/running court, soit annulation effective).
    if (etat.status === "completed") {
      throw new Error("Une session annulée ne doit jamais être complétée");
    }
  });
});
