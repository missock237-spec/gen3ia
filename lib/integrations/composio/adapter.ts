import { z } from "zod";

import type {
  ToolDefinition,
  ToolContext,
} from "@/lib/tools/types";
import { listDeveloperProjectConnectors } from "@/lib/developer/connectors";
import { listHubConnections } from "./connections";

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
      const toolkit = input.toolkit.trim().toLowerCase();

      // Un connecteur n'est utilisable que si le compte externe est réellement
      // actif et vérifié côté Composio. Un projet développeur peut ensuite
      // restreindre cette connexion à une connectionId précise.
      const hubConnections = await listHubConnections(context.userId);
      const verifiedHub = hubConnections.find(
        (item) => item.toolkit === toolkit && item.verified && item.enabled,
      );
      if (!verifiedHub) {
        throw new Error(`Composio toolkit "${toolkit}" n'est pas connecté ou vérifié pour ce compte Gen3ia.`);
      }

      let connectedAccountId = verifiedHub.id;
      if (context.projectId) {
        const connectors = await listDeveloperProjectConnectors(context.userId, context.projectId);
        const projectConnector = connectors.find(
          (item) => item.toolkit === toolkit && item.status === "active" && item.connectionId === verifiedHub.id,
        );
        if (projectConnector) connectedAccountId = projectConnector.connectionId;
      }

      return executeComposioTool({
        userId: context.userId,
        toolSlug: input.toolSlug,
        arguments: input.arguments,
        connectedAccountId,
        signal: context.signal,
      });
    },
  };
}
