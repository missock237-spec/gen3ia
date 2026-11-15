import { Composio } from "@composio/core";

let composioInstance: Composio | null = null;

export function getComposio(): Composio {
  if (composioInstance) {
    return composioInstance;
  }

  const apiKey =
    process.env.COMPOSIO_API_KEY;

  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is not configured.",
    );
  }

  composioInstance = new Composio({
    apiKey,
  });

  return composioInstance;
}
