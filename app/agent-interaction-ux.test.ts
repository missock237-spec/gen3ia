import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 141 — interaction conversation : verrouillage STRUCTUREL des axes
 * conservés, selon la convention du dépôt (lecture des sources — cf.
 * theme-consistency) pour empêcher toute régression future.
 *
 * MISE À JOUR (suppression surfaces workspace/studio) : les verrous portant
 * sur components/workspace/{composer,conversation-workspace,message-thread,
 * template-menu} ont été retirés avec ces fichiers. Restent les verrous sur
 * le MOTEUR et la ROUTE DE STREAMING (conservés : le chat IA du dashboard,
 * aurora-chat et chat-v4 les consomment).
 *
 *  5bis. CHIPS DE SUIVI — suggestions portées par le message persisté ;
 *  7. CÂBLAGE MOTEUR — agentId de bout en bout.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const ENGINE = "lib/domain/conversations/engine.ts";
const STREAM_ROUTE = "app/api/workspace/conversations/[conversationId]/messages/stream/route.ts";
const TYPES = "lib/domain/conversations/types.ts";

describe("Task 141 — axe 5 (conservé) : CHIPS DE SUIVI portées par le message persisté", () => {
  it("les suggestions sont portées par le message persisté (types)", () => {
    const types = read(TYPES);
    expect(types).toContain("suggestions?: string[];");
  });
});

describe("Task 141 — câblage moteur (agentId de bout en bout)", () => {
  const engine = read(ENGINE);
  const route = read(STREAM_ROUTE);

  it("la route de streaming accepte et transmet l'agentId", () => {
    expect(route).toContain("agentId: z.string().trim().min(1).max(128).optional()");
    expect(route).toContain("agentId: body.agentId");
  });

  it("le moteur charge l'agent, injecte sa charte et retombe sur Gen IA en silence", () => {
    expect(engine).toContain("async function loadTurnAgent");
    expect(engine).toContain("input = { ...input, provider: agent.provider, model: input.model ?? agent.model }");
    expect(engine).toContain("La charte de cet agent prime sur ton identité par défaut");
    // Repli silencieux : un agent introuvable ne bloque JAMAIS le tour.
    expect(engine).toContain("repli silencieux sur Gen IA");
  });

  it("la réponse persiste l'agent du tour et ses suggestions", () => {
    expect(engine).toContain("...(ctx.agent ? { agentId: ctx.agent.id, agentName: ctx.agent.name } : {})");
    expect(engine).toContain("suggestions: buildFollowUpSuggestions(ctx.message, content)");
  });

});
