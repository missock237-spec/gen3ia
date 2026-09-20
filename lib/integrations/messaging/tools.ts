import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@/lib/tools/types";
import { getMessagingChannelStatus, sendAgentMessage } from "./index";

const InputSchema = z.object({
  channel: z.enum(["whatsapp", "telegram", "slack"]),
  to: z
    .string()
    .trim()
    .min(3)
    .max(128)
    .describe("Destinataire : numéro WhatsApp (format international), chat ID Telegram (@canal ou identifiant numérique) ou ID/nom de canal Slack (C123… ou #canal)."),
  text: z.string().trim().min(1).max(4096),
});

export const messagingSendTool: ToolDefinition<z.infer<typeof InputSchema>, unknown> = {
  id: "messaging.send",
  name: "messaging.send",
  description:
    "Envoie un message WhatsApp, Telegram ou Slack depuis l'agent (notification, alerte, rapport, lien d'approbation). Chaque message est facturé au wallet.",
  category: "http",
  risk: "medium",
  inputSchema: InputSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const status = getMessagingChannelStatus();
    if (!status[input.channel]) {
      throw new Error(`Le canal ${input.channel} n'est pas configuré sur la plateforme (variables serveur manquantes).`);
    }
    return sendAgentMessage({ userId: context.userId, channel: input.channel, to: input.to, text: input.text });
  },
};
