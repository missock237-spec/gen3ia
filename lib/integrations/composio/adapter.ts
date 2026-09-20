import { z } from "zod";

import type {
  ToolDefinition,
  ToolContext,
} from "@/lib/tools/types";
import { listDeveloperProjectConnectors } from "@/lib/developer/connectors";

import {
  executeComposioTool,
} from "./tools";

const InputSchema =
  z.object({
    toolSlug:
      z.string().min(1),

    toolkit:
      z.string().min(2).max(64),

    arguments:
      z.record(
        z.string(),
        z.unknown(),
      ),
  });

export function createComposioTool(): ToolDefinition<
  z.infer<typeof InputSchema>,
  unknown
> {
  return {
    id:
      "composio.execute",

    name:
      "Composio Execute",

    description:
      "Execute an action through a user's connected external application.",

    category:
      "composio",

    risk:
      "high",

    inputSchema:
      InputSchema,

    async execute(
      input,
      context: ToolContext,
    ) {
      if (!context.userId) {
        throw new Error("A user ID is required.");
      }
      if (!context.projectId) {
        throw new Error("A Gen3ia project is required for Composio execution.");
      }
      const toolkit = input.toolkit.trim().toLowerCase();
      const connectors = await listDeveloperProjectConnectors(context.userId, context.projectId);
      const connector = connectors.find((item) => item.toolkit === toolkit && item.status === "active");
      if (!connector) {
        throw new Error(`Composio toolkit "${toolkit}" is not connected to this Gen3ia project.`);
      }

      return executeComposioTool({
        userId:
          context.userId,

        toolSlug:
          input.toolSlug,

        arguments:
          input.arguments,

        connectedAccountId:
          connector.connectionId,

        signal:
          context.signal,
      });
    },
  };
}
