import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isCodeRepoClarifyingQuestion, isJulesPendingNotice } from "@/lib/ai/code-intent";

/**
 * Task 121 — GARDE STRUCTUREL (pattern « garde fs » du dépôt, cf.
 * engine-video-conversation-id.test.ts) : le routage automatique des demandes
 * de code vers Jules (jules.google) est câblé dans le moteur conversationnel
 * APRÈS les intercepts vidéo/audio (priorité média) et AVANT l'artefact
 * application, et les messages DÉTERMINISTES du moteur satisfont les
 * CONTRATS de détection de code-intent.ts (question de clarification dépôt,
 * avis « intégration en préparation »).
 *
 * Ce garde complète les tests unitaires RÉELS de la détection
 * (lib/ai/code-intent.test.ts) et de la livraison asynchrone
 * (app/api/cron/jules-followup/route.test.ts) : il verrouille le câblage
 * côté moteur, trop lourd à exécuter unitairement (moteur LLM complet).
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

describe("Garde fs — intercept code/Jules dans le moteur conversationnel (Task 121)", () => {
  it("l'intercept code vient APRÈS l'intercept voix et AVANT l'artefact application", () => {
    const voiceIntercept = source.indexOf("if (looksLikeVoiceRequest(input.message))");
    const codeIntercept = source.indexOf("const codeRequest = resolveCodeRequestFromContext(input.message, priorHistory);");
    const appIntercept = source.indexOf("const appIntent = detectAppCreationIntent(input.message);");
    expect(voiceIntercept).toBeGreaterThan(0);
    expect(codeIntercept).toBeGreaterThan(voiceIntercept);
    expect(appIntercept).toBeGreaterThan(codeIntercept);
  });

  it("l'intercept gère les trois régimes : clé absente, dépôt inconnu, dépôt connu", () => {
    const intercept = block(
      "const codeRequest = resolveCodeRequestFromContext(input.message, priorHistory);",
      "// 2 bis) ARTEFACTS",
    );
    expect(intercept).toContain("if (!isJulesConfigured())");
    expect(intercept).toContain("if (!codeRequest.repo)");
    expect(intercept).toContain("await runJulesTurn(baseCtx, codeRequest)");
  });

  it("runJulesTurn crée la session, porte la conversation d'origine et programme le suivi", () => {
    const turn = block("async function runJulesTurn", "/* ------");
    expect(turn).toContain("julesCreateSession");
    expect(turn).toContain("createJulesSessionRecord");
    expect(turn).toContain("conversationId: ctx.conversationId");
    expect(turn).toContain("scheduleJulesFollowup");
  });

  it("la question de clarification dépôt satisfait le contrat isCodeRepoClarifyingQuestion", () => {
    // Le texte RÉEL du moteur est extrait de la source, puis soumis à la
    // détection : le suivi contextuel retrouvera cette question au tour suivant.
    const match = source.match(/"(Sur quel dépôt GitHub[^"]+)"/);
    expect(match).not.toBeNull();
    const question = match![1]!.replace(/\\n/g, "\n");
    expect(isCodeRepoClarifyingQuestion(question)).toBe(true);
  });

  it("l'avis « intégration en préparation » satisfait le contrat isJulesPendingNotice (anti-boucle)", () => {
    const match = source.match(/"(L'intégration de l'agent de code Jules[^"]+)"/);
    expect(match).not.toBeNull();
    const notice = match![1]!.replace(/\\n/g, "\n");
    expect(isJulesPendingNotice(notice)).toBe(true);
  });

  it("aucun refus de cadre dans les réponses Jules du moteur (règle prompt existante)", () => {
    const pendingTurn = block("async function runJulesPendingTurn", "/* ------");
    expect(pendingTurn).toContain("outils internes");
    expect(pendingTurn).not.toMatch(/ne prend en charge que|n[''’]est pas possible de créer|je ne peux pas faire/);
  });

  it("les tools jules.* délèguent au client service partagé (aucun transport dupliqué)", () => {
    const tools = readFileSync(path.join(process.cwd(), "lib/integrations/jules/tools.ts"), "utf8");
    expect(tools).toContain("from \"@/lib/integrations/jules/client\"");
    // Aucun transport HTTP dupliqué : le fetch/authentification vit dans client.ts uniquement.
    expect(tools).not.toContain("julesFetch");
    expect(tools).not.toMatch(/\bfetch\(/);
  });
});
