import { ToolRegistry } from "./registry";
import { webSearchTool } from "./web/search";
import { webOpenTool } from "./web/open";
import { getArtifactTool } from "./files/get-artifact";
import { createArtifactTool } from "./files/create-artifact";
import { createFileTool } from "./files/create";
import { createZipTool } from "./files/create-zip";
import { analyzeZipTool } from "./files/analyze-zip";
import { extractZipTool } from "./files/extract-zip";
import { createComposioTool } from "@/lib/integrations/composio/adapter";
import { adsReadTool } from "@/lib/integrations/composio/ads-tool";
import { messagingSendTool } from "@/lib/integrations/messaging/tools";
import { getMessagingChannelStatus } from "@/lib/integrations/messaging";
import { emailSendTool } from "@/lib/integrations/email/tools";
import { isEmailProviderConfigured } from "@/lib/integrations/email/send";
import { socialPublishTool } from "@/lib/integrations/social/tools";
import { webhookEmitTool } from "@/lib/integrations/webhooks/tools";
import { githubCreateRepositoryTool } from "@/lib/integrations/github/tools";
import {
  voiceListTool,
  voiceSpeakTool,
} from "@/lib/integrations/elevenlabs/tools";
import { twentyFirstUiTool } from "@/lib/integrations/twentyfirst/tool";
import { phoneCallTool } from "@/lib/tools/phone/call";
import {
  notionCreatePageTool,
  notionSearchTool,
} from "@/lib/integrations/notion/tools";
import {
  julesCreateTaskTool,
  julesGetTaskTool,
} from "@/lib/integrations/jules/tools";
import {
  cloudflareDnsCreateTool,
  cloudflareDnsListTool,
  cloudflareZonesListTool,
} from "@/lib/integrations/cloudflare/tools";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webOpenTool,
    getArtifactTool,
    createArtifactTool,
    createFileTool,
    createZipTool,
    analyzeZipTool,
    extractZipTool,
    adsReadTool,
    phoneCallTool,
  ]) registry.register(tool);
  if (process.env.COMPOSIO_API_KEY) {
    registry.register(createComposioTool());
    registry.register(socialPublishTool);
  }
  const messagingStatus = getMessagingChannelStatus();
  if (messagingStatus.whatsapp || messagingStatus.telegram || messagingStatus.slack) {
    registry.register(messagingSendTool);
  }
  if (isEmailProviderConfigured()) registry.register(emailSendTool);
  registry.register(webhookEmitTool);
  if (process.env.GITHUB_TOKEN) registry.register(githubCreateRepositoryTool);
  if (process.env.ELEVENLABS_API_KEY) {
    registry.register(voiceSpeakTool);
    registry.register(voiceListTool);
  }
  if (process.env.TWENTY_FIRST_API_KEY) registry.register(twentyFirstUiTool);
  if (process.env.NOTION_API_TOKEN) {
    registry.register(notionSearchTool);
    registry.register(notionCreatePageTool);
  }
  if (process.env.JULES_API_KEY) {
    registry.register(julesCreateTaskTool);
    registry.register(julesGetTaskTool);
  }
  if (process.env.CLOUDFLARE_API_TOKEN) {
    registry.register(cloudflareZonesListTool);
    registry.register(cloudflareDnsListTool);
    registry.register(cloudflareDnsCreateTool);
  }
  return registry;
}
