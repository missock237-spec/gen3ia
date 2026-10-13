import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { getAgentForUser } from "@/lib/agents/repository";
import { sendBlandCall } from "@/lib/integrations/bland/client";
import { ensureAgentSynced, mapGen3iaLanguageToBland } from "@/lib/voice/bland-agent-sync";
import { createVoiceCallRecord, reserveDailyVoiceCallSlot } from "@/lib/voice/bland-calls";

const PhoneCallInput = z.object({
  agentId: z.string().min(1).optional(),
  to: z.string().regex(/^\+[1-9]\d{7,14}$/),
  objective: z.string().min(3).max(4000),
  firstSentence: z.string().min(2).max(800).optional(),
});

/**
 * Tool « phone.call » — appel vocal réel via Bland AI.
 *
 * L'agent Gen3ia exécutant le tool est synchronisé vers son agent Bland
 * (création/mise à jour si la config a changé), l'appel part en mode
 * agent_id : c'est la version production de l'agent Bland qui conduit la
 * conversation. Le résultat est matérialisé dans « voiceCalls » avec le
 * même cycle de vie que les appels lancés depuis la Call App.
 */
export const phoneCallTool: ToolDefinition<
  z.infer<typeof PhoneCallInput>,
  {
    callId: string;
    status: string;
    blandAgentId: string;
  }
> = {
  id: "phone.call",
  name: "AI Phone Call (Bland)",
  description:
    "Place a real outbound phone call conducted by the synced Bland AI voice agent. Returns the call id for live tracking.",
  category: "system",
  risk: "high",
  inputSchema: PhoneCallInput,
  async execute(input, context) {
    const selectedAgentId = input.agentId ?? context.agentId;
    if (!selectedAgentId) {
      throw new Error("No voice agent context: provide agentId or run this tool from an agent.");
    }
    const agent = await getAgentForUser(context.userId, selectedAgentId);
    if (!agent) throw new Error("Voice agent not found.");
    if (!agent.voiceEnabled || agent.voiceConfig?.outboundEnabled === false) {
      throw new Error("Voice calls are disabled for this agent.");
    }

    // Synchronisation config Gen3ia → agent Bland (au besoin), puis appel.
    const sync = await ensureAgentSynced(context.userId, agent);
    await reserveDailyVoiceCallSlot(context.userId);

    const call = await sendBlandCall({
      phoneNumber: input.to,
      agentId: sync.blandAgentId,
      firstSentence: input.firstSentence ?? agent.voiceConfig?.greeting,
      language: mapGen3iaLanguageToBland(agent.voiceConfig?.language),
      maxDurationMinutes: Math.max(1, Math.ceil((agent.voiceConfig?.maxDurationSeconds ?? 300) / 60)),
      record: true,
      metadata: { userId: context.userId, agentId: agent.id, origin: "gen3ia-tool" },
      requestData: { objective: input.objective },
    });

    const record = await createVoiceCallRecord({
      callId: call.callId,
      userId: context.userId,
      agentId: agent.id,
      agentName: agent.name,
      blandAgentId: sync.blandAgentId,
      to: input.to,
      objective: input.objective,
      language: agent.voiceConfig?.language ?? "fr-FR",
    });

    return { callId: record.id, status: record.status, blandAgentId: sync.blandAgentId };
  },
};
