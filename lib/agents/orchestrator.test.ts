import { describe, expect, it } from "vitest";
import { classifyRoles, createOrchestratorPlan, getAgentDefinition } from "./orchestrator";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { KNOWN_TOOL_SECURITY_NAMES } from "@/lib/security/tool-permissions";

describe("multi-agent orchestrator", () => {
  it("selects customer service, sales and content for a combined business objective", () => {
    const roles = classifyRoles("Gère le support client, les ventes et le contenu TikTok/Instagram");
    expect(roles).toEqual(expect.arrayContaining(["customer_service", "sales", "content"]));
  });

  it("honors explicit requested roles", () => {
    expect(classifyRoles("anything", ["admin", "analytics", "admin"])).toEqual(["admin", "analytics"]);
  });

  it("creates parallel specialist steps and a dependent synthesis step", () => {
    const { roles, plan } = createOrchestratorPlan({ userId: "user-1", objective: "Analyse le marché et prépare une stratégie marketing" });
    expect(roles).toEqual(expect.arrayContaining(["analytics", "content"]));
    const specialistIds = roles.map((role) => `agent-${role}`);
    const specialists = plan.steps.filter((step) => specialistIds.includes(step.id));
    expect(specialists.every((step) => step.dependencies.length === 0)).toBe(true);
    const synthesis = plan.steps.find((step) => step.id === "orchestrator-synthesis");
    expect(synthesis?.dependencies.sort()).toEqual(specialistIds.sort());
  });
});

/**
 * Task 107 — « l'agent IA a accès à TOUS les outils » : AGENT_TOOLS n'est plus
 * une liste codée en dur mais la dérivation automatique du registre
 * (GEN3IA_TOOLS ∪ KNOWN_TOOL_SECURITY_NAMES) ; READ_POLICY couvre les
 * permissions d'exécution fine, sans le destructif (file.delete).
 */
describe("politique orchestrée — registre complet dérivé (Task 107)", () => {
  it("expose le registre complet dans la whitelist (médias, emails, schedules, mcp…)", () => {
    const policy = getAgentDefinition("content").policy;
    for (const tool of ["web.search", "image.generate", "video.create", "email.send", "schedule.create", "mcp.call", "knowledge.search", "web.open", "voice.speak"]) {
      expect(policy.allowedTools).toContain(tool);
    }
  });

  it("suit automatiquement les deux sources canoniques du registre", () => {
    const policy = getAgentDefinition("sales").policy;
    for (const tool of GEN3IA_TOOLS) {
      expect(policy.allowedTools).toContain(tool.name);
    }
    for (const tool of KNOWN_TOOL_SECURITY_NAMES) {
      expect(policy.allowedTools).toContain(tool);
    }
  });

  it("couvre les permissions d'exécution fine sans le destructif (file.delete)", () => {
    const policy = getAgentDefinition("analytics").policy;
    for (const permission of ["tool.external", "network.write", "ads.read", "ads.write", "code.execute", "terminal.execute", "camera.capture"] as const) {
      expect(policy.permissions).toContain(permission);
    }
    // file.delete est whitelisté par la dérivation du registre MAIS refusé par
    // les permissions (destructif, aucun besoin d'orchestration) : l'appel
    // échoue proprement sur « Permission denied ».
    expect(policy.permissions).not.toContain("file.delete");
    expect(policy.permissions).not.toContain("tool.destructive");
    expect(policy.allowFileDelete).toBe(false);
    expect(policy.allowCodeExecution).toBe(true);
    expect(policy.allowExternalApps).toBe(true);
    expect(policy.allowAgentTerminal).toBe(true);
    expect(policy.allowCamera).toBe(true);
  });
});
