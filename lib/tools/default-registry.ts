import { ToolRegistry } from "./registry";
import { webSearchTool } from "./web/search";
import { webOpenTool } from "./web/open";
import { knowledgeSearchTool } from "./knowledge/search";
import { getArtifactTool } from "./files/get-artifact";
import { createArtifactTool } from "./files/create-artifact";
import { createFileTool } from "./files/create";
import { deleteFileTool } from "./files/delete";
import { createZipTool } from "./files/create-zip";
import { analyzeZipTool } from "./files/analyze-zip";
import { extractZipTool } from "./files/extract-zip";
import { createComposioTool } from "@/lib/integrations/composio/adapter";
import { mcpCallTool } from "@/lib/integrations/mcp/tool";
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
import { customApiCallTool, customApiWriteTool } from "@/lib/integrations/custom-apis/tool";
import {
  scheduleCreateTool,
  scheduleListTool,
  scheduleUpdateTool,
  scheduleDeleteTool,
} from "@/lib/tools/schedules";
import {
  workflowCreateTool,
  workflowListTool,
  workflowRunTool,
  workflowDeleteTool,
} from "@/lib/tools/workflows";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webOpenTool,
    knowledgeSearchTool,
    getArtifactTool,
    createArtifactTool,
    createFileTool,
    deleteFileTool,
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
  // MCP : l'outil est toujours enregistré — l'exécution échoue proprement
  // (« serveur introuvable ») si l'utilisateur n'a connecté aucun serveur.
  registry.register(mcpCallTool);
  // API personnelles : toujours enregistrés — l'exécution échoue proprement
  // (« aucune API personnelle ») tant que l'utilisateur n'en a pas fourni.
  registry.register(customApiCallTool);
  registry.register(customApiWriteTool);
  // Tâches planifiées & workflows : toujours enregistrés — la conversation et
  // les agents peuvent créer, lister, modifier, exécuter ou supprimer ces
  // automatisations RÉELLES en langage naturel (échec propre si la cible
  // n'existe pas encore).
  registry.register(scheduleCreateTool);
  registry.register(scheduleListTool);
  registry.register(scheduleUpdateTool);
  registry.register(scheduleDeleteTool);
  registry.register(workflowCreateTool);
  registry.register(workflowListTool);
  registry.register(workflowRunTool);
  registry.register(workflowDeleteTool);
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
