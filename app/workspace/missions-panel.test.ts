import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 16 du plan 20 — Missions + : vue globale des missions récentes
 * (toutes conversations confondues) accessible depuis le panneau de
 * contexte, avec saut vers la conversation d'origine.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Missions récentes — vue globale", () => {
  it("l'API liste les missions de l'utilisateur (propriété stricte, sans index composite requis)", () => {
    const route = read("app/api/workspace/missions/route.ts");
    expect(route).toContain("requireUser");
    expect(route).toContain("listRecentRuns");
    expect(route).toContain("conversationId");
    expect(route).toContain("stepsDone");

    const repository = read("lib/domain/runs/repository.ts");
    expect(repository).toContain("export async function listRecentRuns");
    // Ère R2 (Task 109) : le listing scanne le préfixe runs/ de l'utilisateur
    // (clé canonique users/{uid}/runs/) et trie en mémoire — plus d'index
    // composite Firestore.
    expect(repository).toContain("listJson<RunDoc>(runsPrefix(userId)");
  });

  it("le panneau de contexte expose l'onglet Missions avec saut vers la conversation", () => {
    const drawer = read("components/workspace/context-drawer.tsx");
    expect(drawer).toContain('{ id: "missions", label: "Missions" }');
    expect(drawer).toContain("/api/workspace/missions");
    expect(drawer).toContain("router.push(`/workspace/conversations/${mission.conversationId}`)");
  });
});
