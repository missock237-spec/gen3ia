import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { callUserTool } from "./service";

/**
 * Outil Gen3ia « mcp.call » : exécute un outil exposé par l'un des serveurs
 * MCP connectés par le propriétaire du compte. C'est le pont unique entre
 * le runtime d'agents Gen3ia et tout l'écosystème MCP : l'utilisateur
 * connecte ses serveurs depuis /integrations, l'agent découvre leurs outils
 * et les appelle avec { serverId, tool, args }.
 */

const McpCallInput = z.object({
  serverId: z.string().trim().min(1).max(128),
  tool: z.string().trim().min(1).max(160),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const mcpCallTool: ToolDefinition<z.infer<typeof McpCallInput>, { text: string; isError: boolean }> = {
  name: "mcp.call",
  description:
    "Exécute un outil exposé par l'un des serveurs MCP connectés par l'utilisateur (Google Drive, GitHub, bases de données, etc.). Utilise serverId et le nom exact de l'outil tels que listés dans les serveurs MCP disponibles.",
  category: "mcp",
  risk: "high",
  inputSchema: McpCallInput,
  async execute(input, context) {
    return callUserTool({
      userId: context.userId,
      serverId: input.serverId,
      tool: input.tool,
      args: input.args,
    });
  },
};
