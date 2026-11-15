import { executeTool, ToolExecutor } from "./executor";
import { createDefaultToolRegistry } from "./default-registry";

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
  return executeTool(request);
}
