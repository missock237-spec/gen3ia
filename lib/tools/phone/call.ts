import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { createPhoneCallSession, startPhoneCall } from "@/lib/integrations/twilio/calls";
import { getAgentForOwner } from "@/lib/agents/repository";
import { listAgentPhoneNumbers } from "@/lib/integrations/twilio/numbers";

const PhoneCallInput = z.object({
  agentId: z.string().min(1).optional(),
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
    const selectedAgentId = input.agentId ?? context.agentId;
    const agent = selectedAgentId ? await getAgentForOwner(context.userId, selectedAgentId) : null;
    if (input.agentId && !agent) throw new Error("Voice agent not found.");
    if (agent && !agent.voiceEnabled) throw new Error("Voice calls are disabled for this agent.");
    const assignedNumber = agent ? (await listAgentPhoneNumbers(context.userId, agent.id)).find((item) => item.status === "active") : null;
    if (agent && !assignedNumber) throw new Error("This voice agent has no active phone number.");
    const session = await createPhoneCallSession({
      userId: context.userId,
      agentId: agent?.id,
      systemPrompt: agent?.systemPrompt,
      executionId: context.executionId ?? randomUUID(),
      to: input.to,
      objective: input.objective,
      opening: agent?.voiceConfig?.greeting ?? input.opening, input.opening,
      language: agent?.voiceConfig?.language ?? input.language,
      maxTurns: agent?.voiceConfig?.maxTurns ?? input.maxTurns,
      maxDurationSeconds: agent?.voiceConfig?.maxDurationSeconds ?? input.maxDurationSeconds,
    });
    try {
      const call = await startPhoneCall(session.id);
      return { sessionId: session.id, callSid: call.callSid, status: call.status };
    } catch (error) {
      throw error;
    }
  },
};
