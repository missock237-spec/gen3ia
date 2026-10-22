import { describe, expect, it } from "vitest";

import type { AIRequest } from "@/lib/ai/models";

import { createRng } from "./core/rng";
import { EspaceFiltreResonant } from "./core/resonant-space";
import { GenerateurAutoOscillation } from "./core/auto-oscillation";
import { NoyauCentralGen3 } from "./core/central-core";
import { ReseauNeuronalGen3 } from "./core/network";
import { CANAL_UTILISATEUR_IN } from "./core/types";
import { HippocampusMemory } from "./memory/hippocampus";
import { NeuralEngine } from "./engine";
import type { CortexLangagierGen3, ContexteLangage } from "./generation/language";

/**
 * ISOLEMENT DE LA MÉMOIRE DE TRAVAIL PAR UTILISATEUR (durcissement
 * 2026-10-22 — P0) : l'hippocampe historique est un singleton partagé par
 * TOUS les comptes — l'anaphore « et toi ? » d'un utilisateur pouvait
 * capter le dernier tour d'un AUTRE (fuite de contexte entre comptes).
 *
 * Vérifié ici par un cortex double qui capture le ContexteLangage reçu :
 *  - sans metadata (appels système/tests) : comportement historique conservé ;
 *  - avec metadata (userId, conversationId) : fenêtres distinctes ;
 *  - la continuité est PRÉSERVÉE au sein d'une même conversation.
 */

function monterMoteur(): {
  engine: NeuralEngine;
  contextesCaptures: ContexteLangage[];
  hippocampePartage: HippocampusMemory;
} {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [0, 1, 2]);
  espace.registerOutputPool("GENERER_IMAGE", [3, 4, 5]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);

  const contextesCaptures: ContexteLangage[] = [];
  const cortex = {
    repondre: (_prompt: string, contexte: ContexteLangage) => {
      contextesCaptures.push({ ...contexte });
      return {
        texte: "réponse de test déterministe",
        source: "corpus" as const,
        theme: "test",
        score: 0.9,
      };
    },
    tailleVocabulaire: 0,
  } as unknown as CortexLangagierGen3;

  const hippocampePartage = new HippocampusMemory(10);
  const engine = new NeuralEngine(noyau, espace, cortex, hippocampePartage);
  return { engine, contextesCaptures, hippocampePartage };
}

function requete(message: string, metadata?: Record<string, string>): AIRequest {
  return {
    task: "chat",
    messages: [{ role: "user", content: message }],
    ...(metadata ? { metadata } : {}),
  };
}

describe("NeuralEngine — mémoire de travail par conversation", () => {
  it("sans metadata : comportement historique conservé (fenêtre partagée)", async () => {
    const { engine, contextesCaptures } = monterMoteur();

    await engine.generate(requete("j'adore les pizzas ananas"));
    await engine.generate(requete("et toi ?"));

    // Premier tour : aucun contexte. Deuxième tour : le premier tour est
    // rappelé (mémoire de travail partagée historique, appels sans identité).
    expect(contextesCaptures[0].messagePrecedent).toBeUndefined();
    expect(contextesCaptures[1].messagePrecedent).toContain("pizzas");
  });

  it("deux utilisateurs distincts ne se voient JAMAIS le dernier tour", async () => {
    const { engine, contextesCaptures } = monterMoteur();

    await engine.generate(
      requete("je prépare un gâteau au chocolat", { userId: "alice", conversationId: "conv-a" }),
    );
    await engine.generate(
      requete("et toi ?", { userId: "bob", conversationId: "conv-b" }),
    );

    const contexteBob = contextesCaptures[1];
    expect(contexteBob.messagePrecedent).toBeUndefined();
    expect(contexteBob.reponsePrecedente).toBeUndefined();
  });

  it("la continuité est préservée au sein d'une même conversation", async () => {
    const { engine, contextesCaptures } = monterMoteur();

    await engine.generate(
      requete("je prépare un gâteau au chocolat", { userId: "alice", conversationId: "conv-a" }),
    );
    await engine.generate(
      requete("et toi ?", { userId: "alice", conversationId: "conv-a" }),
    );

    expect(contextesCaptures[1].messagePrecedent).toContain("gâteau");
    expect(contextesCaptures[1].reponsePrecedente).toContain("déterministe");
  });

  it("une même conversation reprend après un échange d'un autre utilisateur", async () => {
    const { engine, contextesCaptures } = monterMoteur();

    await engine.generate(
      requete("mon plat préféré est le ndolé", { userId: "alice", conversationId: "conv-a" }),
    );
    await engine.generate(
      requete("coucou", { userId: "bob", conversationId: "conv-b" }),
    );
    await engine.generate(
      requete("et toi ?", { userId: "alice", conversationId: "conv-a" }),
    );

    // Le tour d'alice réapparait — la fenêtre de sa conversation a été
    // intacte pendant l'échange de bob (ni écrasée, ni polluée).
    expect(contextesCaptures[2].messagePrecedent).toContain("ndolé");
    expect(contextesCaptures[2].messagePrecedent).not.toContain("coucou");
  });

  it("l'hippocampe partagé n'est plus alimenté par les tours identifiés", async () => {
    const { engine, hippocampePartage } = monterMoteur();

    await engine.generate(
      requete("message privé d'alice", { userId: "alice", conversationId: "conv-a" }),
    );

    expect(hippocampePartage.getHistory()).toHaveLength(0);
  });
});
