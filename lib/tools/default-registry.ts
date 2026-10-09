import { ToolRegistry } from "./registry";
import { webSearchTool } from "./web/search";
import { webOpenTool } from "./web/open";
import { knowledgeSearchTool } from "./knowledge/search";
import { getArtifactTool } from "./files/get-artifact";
import { createArtifactTool } from "./files/create-artifact";
import { createFileTool } from "./files/create";
import { readFileTool } from "./files/read-file";
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
import { webApiTool, webApiWriteTool } from "@/lib/tools/web/api";
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
import {
  networkListTool,
  networkSendMessageTool,
  networkReadInboxTool,
  networkMarkReadTool,
} from "@/lib/agents/networks/tools";
import { generateImageTool } from "@/lib/tools/media/generate-image";
import { createVideoTool } from "@/lib/tools/media/create-video";
import { analyzeMediaTool } from "@/lib/tools/media/analyze-media";
import { videoStatusTool } from "@/lib/tools/media/video-status";
import { videoReviseTool } from "@/lib/tools/media/video-revise";
import { isImageGenerationEnabled } from "@/lib/ai/image-generation";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webOpenTool,
    knowledgeSearchTool,
    getArtifactTool,
    createArtifactTool,
    createFileTool,
    // file.read RÉEL : lecture des pièces jointes du stockage permanent du
    // propriétaire (conversion texte réelle) et des fichiers de workspace —
    // l'outil était annoncé au planificateur mais aucun exécuteur n'existait.
    readFileTool,
    deleteFileTool,
    createZipTool,
    analyzeZipTool,
    extractZipTool,
    adsReadTool,
    phoneCallTool,
    // Task 106-a — pilote vidéo complet du chat : création, suivi,
    // révision/pause/annulation/exports (le pipeline existait déjà).
    videoStatusTool,
    videoReviseTool,
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
  // API directe par URL : toujours enregistrés — les agents peuvent appeler
  // n'importe quelle API publique désignée par URL, sans connecteur préalable
  // (lecture directe, écriture gated par validation humaine).
  registry.register(webApiTool);
  registry.register(webApiWriteTool);
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
  // Équipes d'agents persistantes : toujours enregistrés — opérations
  // internes propriétaire-scopées (échec propre si aucun réseau n'existe).
  registry.register(networkListTool);
  registry.register(networkSendMessageTool);
  registry.register(networkReadInboxTool);
  registry.register(networkMarkReadTool);
  if (process.env.GITHUB_TOKEN) registry.register(githubCreateRepositoryTool);
  if (process.env.ELEVENLABS_API_KEY) {
    registry.register(voiceSpeakTool);
    registry.register(voiceListTool);
  }
  // Médias RÉELS (audit outils médias) : génération d'image Agnes AI (la MÊME
  // voie que le chat conversationnel) et production vidéo autonome (file
  // interne payante). Gated par la clé Agnes — sans clé, les outils
  // n'existent PAS au registre (aucune capacité fantôme annoncée aux
  // planners) ; avec clé, « image.generate » devient un outil exécutable
  // réel là où la conversation l'annonçait déjà. La production vidéo charge
  // son module par import paresseux au moment de l'exécution.
  if (isImageGenerationEnabled()) {
    registry.register(generateImageTool);
    registry.register(createVideoTool);
  }
  // Analyse média RÉELLE (image / audio / vidéo) — l'agent et la
  // conversation sont connectés à la couche lib/media/analysis. Toujours
  // enregistré : sans fournisseur, l'outil échoue HONNÊTEMENT en nommant la
  // variable d'environnement manquante (aucune capacité fantôme — le
  // contrat d'erreur est explicite).
  registry.register(analyzeMediaTool);
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
