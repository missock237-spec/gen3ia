import { describe, expect, it } from "vitest";

import { forceSensitiveToolFlags } from "./unified-agent";

describe("forceSensitiveToolFlags", () => {
  const sensitive = new Set(["file.delete", "phone.call", "composio.execute", "ads.publish", "terminal.execute"]);

  it("force sideEffect et requiresApproval sur un outil externe oublié par le planificateur", () => {
    const steps = [
      { id: "s1", type: "tool", toolName: "composio.execute", sideEffect: false, requiresApproval: false },
      { id: "s2", type: "llm", toolName: undefined, sideEffect: false, requiresApproval: false },
    ];
    const result = forceSensitiveToolFlags(steps, sensitive);
    expect(result[0].sideEffect).toBe(true);
    expect(result[0].requiresApproval).toBe(true);
  });

  it("ne touche PAS les étapes llm ni les outils non sensibles", () => {
    const steps = [
      { id: "s1", type: "llm", toolName: undefined, sideEffect: false, requiresApproval: false },
      { id: "s2", type: "tool", toolName: "web.search", sideEffect: false, requiresApproval: false },
    ];
    const result = forceSensitiveToolFlags(steps, sensitive);
    expect(result[0].requiresApproval).toBe(false);
    expect(result[1].requiresApproval).toBe(false);
    expect(result[1].sideEffect).toBe(false);
  });

  it("préserve un marquage déjà correct", () => {
    const steps = [{ id: "s1", type: "tool", toolName: "file.delete", sideEffect: true, requiresApproval: true }];
    const result = forceSensitiveToolFlags(steps, sensitive);
    expect(result[0].sideEffect).toBe(true);
    expect(result[0].requiresApproval).toBe(true);
  });
});
