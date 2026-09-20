import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@/lib/tools/types";
import { isEmailProviderConfigured, sendAgentEmail } from "./send";

const InputSchema = z.object({
  to: z.union([z.string().trim().max(320), z.array(z.string().trim().max(320)).min(1).max(10)]).describe(
    "Destinataire(s) : une adresse email ou un tableau d'adresses (10 max).",
  ),
  subject: z.string().trim().min(1).max(200),
  text: z.string().max(100_000).optional().describe("Version texte brut du message."),
  html: z.string().max(200_000).optional().describe("Version HTML du message (optionnelle)."),
});

export const emailSendTool: ToolDefinition<z.infer<typeof InputSchema>, unknown> = {
  id: "email.send",
  name: "email.send",
  description:
    "Envoie un email depuis l'agent (rapport, relance, synthèse de mission). Maximum 10 destinataires. Chaque destinataire est facturé au wallet.",
  category: "http",
  risk: "medium",
  inputSchema: InputSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    if (!isEmailProviderConfigured()) {
      throw new Error("L'envoi d'email n'est pas configuré sur la plateforme (RESEND_API_KEY / EMAIL_FROM_ADDRESS manquants).");
    }
    return sendAgentEmail({ userId: context.userId, ...input });
  },
};
