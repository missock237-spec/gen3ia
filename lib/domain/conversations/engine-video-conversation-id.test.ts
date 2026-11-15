import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 107-a — GARDE STRUCTUREL (pattern « garde fs » du dépôt, cf.
 * lib/queue/origin.test.ts) : les DEUX points de création d'un job vidéo
 * dans le moteur conversationnel — le tour vidéo dédié (runVideoTurn) et
 * l'intercept video.create du plan d'exécution — doivent porter la
 * conversation d'origine (`conversationId: ctx.conversationId`) pour que la
 * complétion « monte » le résultat DANS le chat (livraison automatique par
 * lib/video/production-queue.deliverJobToConversation).
 *
 * MISE À JOUR (découpage moteur) : runVideoTurn vit désormais dans
 * engine-media.ts et l'intercept video.create dans engine-plan.ts —
 * le garde lit ces modules directement.
 *
 * Ce garde complète les tests unitaires RÉELS de la livraison
 * (lib/video/production-queue-delivery.test.ts) : il verrouille le câblage
 * côté appelant, trop lourd à exécuter unitairement (moteur LLM complet).
 */

const mediaSource = readFileSync(
  path.join(process.cwd(), "lib/domain/conversations/engine-media.ts"),
  "utf8",
);
const planSource = readFileSync(
  path.join(process.cwd(), "lib/domain/conversations/engine-plan.ts"),
  "utf8",
);

describe("Garde fs — portage de conversationId dans le moteur conversationnel (Task 107-a)", () => {
  it("runVideoTurn passe conversationId: ctx.conversationId à createVideoProductionJob", () => {
    const start = mediaSource.indexOf("async function runVideoTurn");
    expect(start).toBeGreaterThanOrEqual(0);
    const runVideoTurn = mediaSource.slice(start);
    expect(runVideoTurn).toContain("createVideoProductionJob");
    expect(runVideoTurn).toContain("conversationId: ctx.conversationId");
  });

  it("l'intercept video.create passe conversationId: ctx.conversationId à createVideoProductionJob", () => {
    const start = planSource.indexOf('planned.toolName === "video.create"');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = planSource.indexOf('planned.toolName === "video.status"', start);
    expect(end).toBeGreaterThan(start);
    const intercept = planSource.slice(start, end);
    expect(intercept).toContain("createVideoProductionJob");
    expect(intercept).toContain("conversationId: ctx.conversationId");
  });

  it("l'outil video.create lit la conversation depuis le CONTEXTE (metadata), jamais un champ d'entrée LLM", () => {
    const toolSource = readFileSync(path.join(process.cwd(), "lib/tools/media/create-video.ts"), "utf8");
    expect(toolSource).toContain("context.metadata?.conversationId");
    // Le schéma d'entrée n'expose PAS conversationId (l'LLM ne peut pas l'inventer).
    expect(toolSource).not.toMatch(/conversationId:\s*z\./);
  });
});
