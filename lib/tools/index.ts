import { executeTool, ToolExecutor } from "./executor";
import { createDefaultToolRegistry } from "./default-registry";
import { executerOutilViaGateway } from "@/lib/capabilities/execution/pont-legacy";

/**
 * V1.1 — `executeTool` et `ToolExecutor` restent exportés comme ADAPTATEURS
 * INTERNES du Universal Execution Gateway (conservés pour compatibilité).
 * Tout appelant EXTERNE doit passer par la passerelle (pont legacy :
 * `executerOutilViaGateway`) — la garde automatique
 * `lib/capabilities/tests/gateway-monopole.test.ts` interdit le contournement.
 */
export { executeTool, ToolExecutor };
export { createDefaultToolRegistry };
export * from "./types";

/**
 * Shared process-wide tool registry instance.
 * Built from the default tool set so planner/agent modules can inspect
 * the available tools without each creating their own registry.
 */
export const toolRegistry = createDefaultToolRegistry();

export async function executeRegisteredTool(request: Parameters<typeof executeTool>[0]) {
  // V1.1 : délégation par la passerelle unique (traçabilité UCE complète).
  return executerOutilViaGateway({ ...request, origine: "tools-index" });
}
