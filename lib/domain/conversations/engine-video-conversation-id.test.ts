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
 * Ce garde complète les tests unitaires RÉELS de la livraison
 * (lib/video/production-queue-delivery.test.ts) : il verrouille le câblage
 * côté appelant, trop lourd à exécuter unitairement (moteur LLM complet).
 */

const source = readFileSync(path.join(process.cwd(), "lib/domain/conversations/engine.ts"), "utf8");

/** Extrait le bloc source entre deux marqueurs (échoue si introuvable). */
function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Garde fs — portage de conversationId dans le moteur conversationnel (Task 107-a)", () => {
  it("runVideoTurn passe conversationId: ctx.conversationId à createVideoProductionJob", () => {
    const runVideoTurn = block("async function runVideoTurn", "async function runAppTurn");
    expect(runVideoTurn).toContain("createVideoProductionJob");
    expect(runVideoTurn).toContain("conversationId: ctx.conversationId");
  });

  it("l'intercept video.create passe conversationId: ctx.conversationId à createVideoProductionJob", () => {
    const intercept = block('planned.toolName === "video.create"', 'planned.toolName === "video.status"');
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
