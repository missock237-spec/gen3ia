import { ToolRegistry } from "./registry";
import { webSearchTool } from "./web/search";
import { webOpenTool } from "./web/open";
import { terminalRunTool } from "./terminal/run";
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
// Task 133 — connecteurs entreprise : outils Zendesk (tickets) et ServiceNow
// (incidents ITSM) dérivés du hub de connexions Composio.
import {
  servicenowIncidentCreateTool,
  servicenowIncidentQueryTool,
  servicenowIncidentUpdateTool,
  zendeskTicketCreateTool,
  zendeskTicketListTool,
  zendeskTicketSearchTool,
  zendeskTicketUpdateTool,
} from "@/lib/integrations/composio/tools";
import { messagingSendTool } from "@/lib/integrations/messaging/tools";
import { getMessagingChannelStatus } from "@/lib/integrations/messaging";
import { emailSendTool } from "@/lib/integrations/email/tools";
import { isEmailProviderConfigured } from "@/lib/integrations/email/send";
import { socialPublishTool } from "@/lib/integrations/social/tools";
import { webhookEmitTool } from "@/lib/integrations/webhooks/tools";
import { githubCreateRepositoryTool } from "@/lib/integrations/github/tools";
import { generateImageNeuralTool } from "@/lib/tools/media/generate-image-neural";
import {
  notionCreatePageTool,
  notionSearchTool,
} from "@/lib/integrations/notion/tools";
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
import { createVideoTool } from "@/lib/tools/media/create-video";
import { videoStatusTool } from "@/lib/tools/media/video-status";
import { videoReviseTool } from "@/lib/tools/media/video-revise";
// Task 140 — suite « outils pilotés par les agents IA » (16 outils) :
// les imports sont groupés par lot d'implémentation (sous-agents 140-a/b/c/d).
import { handoverComposeTool } from "@/lib/tools/agent-suite/handover-compose";
import { terminalShieldTool } from "@/lib/tools/agent-suite/terminal-shield";
import { registryFindTool } from "@/lib/tools/agent-suite/registry-find";
import { buildAutofixTool } from "@/lib/tools/agent-suite/build-autofix";
import { simulationRunTool } from "@/lib/tools/agent-suite/simulation-run";
import { browserNavigateTool } from "@/lib/tools/agent-suite/browser-navigate";
import { schemaExtractTool } from "@/lib/tools/agent-suite/schema-extract";
import { voicemailRespondTool } from "@/lib/tools/agent-suite/voicemail-respond";
import { transcriptRedactTool } from "@/lib/tools/agent-suite/transcript-redact";
import { ivrNavigateTool } from "@/lib/tools/agent-suite/ivr-navigate";
import { webhookHealTool } from "@/lib/tools/agent-suite/webhook-heal";
import { watchdogTrackTool } from "@/lib/tools/agent-suite/watchdog-track";
import { terminalGuideTool } from "@/lib/tools/agent-suite/terminal-guide";
import { contentPackageTool } from "@/lib/tools/agent-suite/content-package";
import { knowledgeGraphTool } from "@/lib/tools/agent-suite/knowledge-graph";
import { decisionAnalyzeTool } from "@/lib/tools/agent-suite/decision-analyze";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    webSearchTool,
    webOpenTool,
    // Task 122 — terminal intégré FONCTIONNEL : outil agent d'exécution
    // RÉELLE de commandes (Docker > serverless en-processus > simulation
    // annoncée). Toujours enregistré : le repli simulation est un résultat
    // honnête (mode renvoyé), pas une capacité fantôme.
    terminalRunTool,
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
    // Task 106-a — pilote vidéo complet du chat : création, suivi,
    // révision/pause/annulation/exports (le pipeline existait déjà).
    videoStatusTool,
    videoReviseTool,
  ]) registry.register(tool);
  if (process.env.COMPOSIO_API_KEY) {
    registry.register(createComposioTool());
    registry.register(socialPublishTool);
    // Task 133 — Zendesk & ServiceNow : mêmes garanties que composio.execute
    // (connexion vérifiée obligatoire), avec schémas typés par action.
    registry.register(zendeskTicketCreateTool);
    registry.register(zendeskTicketUpdateTool);
    registry.register(zendeskTicketListTool);
    registry.register(zendeskTicketSearchTool);
    registry.register(servicenowIncidentCreateTool);
    registry.register(servicenowIncidentUpdateTool);
    registry.register(servicenowIncidentQueryTool);
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
  // MÉDIAS NEURONAUX LOCAUX : génération d'image par le moteur Gen3
  // (composition calculée depuis l'état réel du cerveau — aucune IA
  // externe, aucune clé requise) et production vidéo autonome (file
  // interne : scénario → visuels neuronaux → narration utilisateur →
  // montage Ken Burns → rendu).
  registry.register(generateImageNeuralTool);
  registry.register(createVideoTool);
  if (process.env.NOTION_API_TOKEN) {
    registry.register(notionSearchTool);
    registry.register(notionCreatePageTool);
  }
  if (process.env.CLOUDFLARE_API_TOKEN) {
    registry.register(cloudflareZonesListTool);
    registry.register(cloudflareDnsListTool);
    registry.register(cloudflareDnsCreateTool);
  }
  // Task 140 — SUITE « OUTILS PILOTÉS PAR LES AGENTS IA » (16 outils).
  //
  // 15 outils INTERNES à la plateforme (LLM facturé via generateStructuredForUser,
  // fetchs publics SSRF-gardés, calcul déterministe, livrables persistés) :
  // TOUJOURS enregistrés — sans fournisseur configuré, ils échouent
  // honnêtement en nommant la variable d'environnement manquante (aucune
  // capacité fantôme). Aucune carte de validation (directive 10-10) pour les
  // outils internes : voir lib/agents/approval-policy.ts.
  registry.register(handoverComposeTool);
  registry.register(terminalShieldTool);
  registry.register(registryFindTool);
  registry.register(simulationRunTool);
  registry.register(browserNavigateTool);
  registry.register(schemaExtractTool);
  registry.register(voicemailRespondTool);
  registry.register(transcriptRedactTool);
  registry.register(ivrNavigateTool);
  registry.register(webhookHealTool);
  registry.register(watchdogTrackTool);
  registry.register(terminalGuideTool);
  registry.register(contentPackageTool);
  registry.register(knowledgeGraphTool);
  registry.register(decisionAnalyzeTool);
  // build.autofix : crée une PULL REQUEST GitHub réelle — gated par le token
  // de la plateforme (comme github.create_repository) ; sans token, l'outil
  // n'est ni enregistré ni annoncé au planner.
  if (process.env.GITHUB_TOKEN) registry.register(buildAutofixTool);
  return registry;
}
