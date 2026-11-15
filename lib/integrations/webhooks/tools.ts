import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@/lib/tools/types";
import { OUTGOING_WEBHOOK_EVENTS } from "./store";
import { emitOutgoingEvent } from "./emit";

const InputSchema = z.object({
  event: z.enum(OUTGOING_WEBHOOK_EVENTS),
  payload: z.record(z.string(), z.unknown()).default({}).describe("Charge utile métier transmise aux endpoints abonnés."),
});

export const webhookEmitTool: ToolDefinition<z.infer<typeof InputSchema>, unknown> = {
  id: "webhook.emit",
  name: "webhook.emit",
  description:
    "Émet un événement Gen3ia vers les endpoints de webhooks externes déclarés par l'utilisateur (n8n, Make, Zapier…). Livraisons signées HMAC-SHA256.",
  category: "http",
  risk: "medium",
  inputSchema: InputSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const results = await emitOutgoingEvent({ userId: context.userId, event: input.event, payload: input.payload });
    return {
      event: input.event,
      deliveries: results,
      delivered: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
    };
  },
};
