import {
  getComposio,
} from "./client";

export interface ComposioToolInfo {
  slug: string;
  name?: string;
  description?: string;
  toolkit?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export async function getComposioTools(
  userId: string,
  toolkits?: string[],
): Promise<unknown> {
  const composio =
    getComposio();

  return composio.tools.get(
    userId,
    toolkits && toolkits.length > 0
      ? { toolkits }
      : { toolkits: [] },
  );
}

export async function executeComposioTool(
  params: {
    userId: string;
    toolSlug: string;
    arguments: Record<
      string,
      unknown
    >;
    connectedAccountId?: string;
    version?: string;
    signal?: AbortSignal;
  },
) {
  const composio =
    getComposio();

  const version =
    params.version ??
    process.env.COMPOSIO_TOOLKIT_VERSION;

  if (version) {
    return composio.tools.execute(
      params.toolSlug,
      {
        userId:
          params.userId,

        ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),

        version,

        arguments:
          params.arguments,
      },
      {
        signal:
          params.signal,
      },
    );
  }

  return composio.tools.execute(
    params.toolSlug,
    {
      userId:
        params.userId,

      ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),

      arguments:
        params.arguments,

      dangerouslySkipVersionCheck:
        true,
    },
    {
      signal:
        params.signal,
    },
  );
}
