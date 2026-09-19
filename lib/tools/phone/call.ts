import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { createPhoneCallSession, startPhoneCall } from "@/lib/integrations/twilio/calls";

const PhoneCallInput = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/),
  objective: z.string().min(3).max(4000),
  opening: z.string().min(2).max(800).default("Bonjour, je vous appelle au nom de Gen3ia."),
  language: z.enum(["fr-FR", "en-US", "en-GB", "es-ES", "de-DE"]).default("fr-FR"),
  maxTurns: z.number().int().min(1).max(20).default(8),
  maxDurationSeconds: z.number().int().min(30).max(900).default(300),
});

export const phoneCallTool: ToolDefinition<z.infer<typeof PhoneCallInput>, {
  sessionId: string;
  callSid: string;
  status: string;
}> = {
  id: "phone.call",
  name: "AI Phone Call",
  description: "Place a controlled outbound phone call and let a Gen3ia voice agent conduct a bounded conversation.",
  category: "system",
  risk: "high",
  inputSchema: PhoneCallInput,
  async execute(input, context) {
    const session = await createPhoneCallSession({
      userId: context.userId,
      executionId: context.executionId ?? crypto.randomUUID(),
      to: input.to,
      objective: input.objective,
      opening: input.opening,
      language: input.language,
      maxTurns: input.maxTurns,
      maxDurationSeconds: input.maxDurationSeconds,
    });
    try {
      const call = await startPhoneCall(session.id);
      return { sessionId: session.id, callSid: call.callSid, status: call.status };
    } catch (error) {
      throw error;
    }
  },
};
