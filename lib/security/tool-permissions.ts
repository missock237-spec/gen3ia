import { ExecutionPolicy, Permission, ToolRisk, assertPermission, assertToolAllowed } from "./execution-policy";

export interface ToolSecurityDefinition { name: string; risk: ToolRisk; requiredPermissions: Permission[]; network?: boolean; filesystemRead?: boolean; filesystemWrite?: boolean; destructive?: boolean; externalApp?: boolean; }

const TOOL_SECURITY: Record<string, ToolSecurityDefinition> = {
  "web.search": { name: "web.search", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "web.open": { name: "web.open", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "file.read": { name: "file.read", risk: "read", requiredPermissions: ["tool.read", "file.read"], filesystemRead: true },
  "file.create": { name: "file.create", risk: "write", requiredPermissions: ["tool.write", "file.create", "file.write"], filesystemWrite: true },
  // it.58 — renommé artifact.get (ID réel de l'exécuteur) ; file.modify,
  // voice.list, phone.call, ui.components, jules.* RETIRÉS (fantômes —
  // aucun exécuteur au registre, le planner ne doit plus les planifier).
  "artifact.get": { name: "artifact.get", risk: "read", requiredPermissions: ["tool.read", "file.read"] },
  "file.delete": { name: "file.delete", risk: "destructive", requiredPermissions: ["tool.destructive", "file.delete"], filesystemWrite: true, destructive: true },
  "zip.analyze": { name: "zip.analyze", risk: "read", requiredPermissions: ["tool.read", "file.read"], filesystemRead: true },
  "zip.create": { name: "zip.create", risk: "write", requiredPermissions: ["tool.write", "file.write"], filesystemRead: true, filesystemWrite: true },
  "zip.extract": { name: "zip.extract", risk: "write", requiredPermissions: ["tool.write", "file.write", "file.create"], filesystemRead: true, filesystemWrite: true },
  "artifact.create": { name: "artifact.create", risk: "write", requiredPermissions: ["tool.write", "file.write"], filesystemRead: true, filesystemWrite: true },
  // it.58 : l'alias artifact.download est supprimé — l'ID réel est artifact.get.
  "composio.execute": { name: "composio.execute", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "mcp.call": { name: "mcp.call", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "code.execute": { name: "code.execute", risk: "destructive", requiredPermissions: ["code.execute"] },
  "terminal.execute": { name: "terminal.execute", risk: "destructive", requiredPermissions: ["terminal.execute"] },
  // Task 122 — terminal.run : exécution RÉELLE en-processus (microVM
  // serverless de la plateforme : env NETTOYÉ, cwd /tmp, deny-list durcie,
  // timeout/sortie plafonnés). Outil INTERNE au sens de la directive 10-10
  // (aucune app externe, aucun secret utilisateur manipulé) → capacité
  // d'écriture interne, comme schedule.*/video.* ; le flag terminal reste
  // gated par allowAgentTerminal (défense en profondeur).
  "terminal.run": { name: "terminal.run", risk: "write", requiredPermissions: ["tool.read", "tool.write"], filesystemWrite: true },
  "memory.read": { name: "memory.read", risk: "read", requiredPermissions: ["tool.read", "memory.read"] },
  "memory.write": { name: "memory.write", risk: "write", requiredPermissions: ["tool.write", "memory.write"] },
  "camera.capture": { name: "camera.capture", risk: "external", requiredPermissions: ["tool.external", "camera.capture"], externalApp: true },
  "ads.read": { name: "ads.read", risk: "read", requiredPermissions: ["tool.read", "ads.read", "network.read"], network: true, externalApp: true },
  "ads.publish": { name: "ads.publish", risk: "external", requiredPermissions: ["tool.external", "tool.write", "ads.write", "network.write"], network: true, externalApp: true },
  "github.create_repository": { name: "github.create_repository", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  // voice.speak : synthèse audio NEURONALE LOCALE (audit multimodal) —
  // plus aucun appel réseau (l'ancien moteur ElevenLabs a été supprimé).
  // it.58 : voice.list et phone.call retirés (fantômes — exécuteurs
  // externes retirés de la plateforme, règle zéro service IA externe).
  "voice.speak": { name: "voice.speak", risk: "write", requiredPermissions: ["tool.write"] },
  "notion.search": { name: "notion.search", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "notion.create_page": { name: "notion.create_page", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "cloudflare.zones.list": { name: "cloudflare.zones.list", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "cloudflare.dns.list": { name: "cloudflare.dns.list", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "cloudflare.dns.create": { name: "cloudflare.dns.create", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "custom_api.call": { name: "custom_api.call", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "custom_api.write": { name: "custom_api.write", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  // API directe par URL : l'agent appelle n'importe quelle API publique
  // désignée par URL (garde SSRF côté outil). Lecture directe ; l'écriture
  // est une action externe gated par validation humaine (risque high porté
  // par la définition de l'outil dans lib/tools).
  "web.api": { name: "web.api", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "web.api.write": { name: "web.api.write", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  // Envoi d'email réel (Resend, côté serveur) : appel réseau externe au nom de
  // la plateforme. Le risque HITL (medium → exécution directe) est porté par
  // la définition de l'outil dans lib/tools, la définition de sécurité ici ne
  // décrit que la capacité.
  "email.send": { name: "email.send", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true },
  // Sous-services du projet (tâches planifiées, workflows) : opérations
  // INTERNES (Firestore, aucun réseau ni fichier) — le risque HITL (high →
  // carte de validation) est porté par la définition de l'outil dans
  // lib/tools, la définition de sécurité ici ne décrit que la capacité.
  "schedule.create": { name: "schedule.create", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  "schedule.list": { name: "schedule.list", risk: "read", requiredPermissions: ["tool.read"] },
  "schedule.update": { name: "schedule.update", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  "schedule.delete": { name: "schedule.delete", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  "workflow.create": { name: "workflow.create", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  "workflow.list": { name: "workflow.list", risk: "read", requiredPermissions: ["tool.read"] },
  "workflow.run": { name: "workflow.run", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  "workflow.delete": { name: "workflow.delete", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Outils d'équipe (réseaux d'agents persistants) : opérations INTERNES
  // (Firestore, aucun réseau ni fichier) — la messagerie est bornée aux
  // coéquipiers du MÊME réseau du MÊME propriétaire (validation au dépôt).
  "network.list": { name: "network.list", risk: "read", requiredPermissions: ["tool.read"] },
  "network.send_message": { name: "network.send_message", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  "network.read_inbox": { name: "network.read_inbox", risk: "read", requiredPermissions: ["tool.read"] },
  "network.mark_read": { name: "network.mark_read", risk: "read", requiredPermissions: ["tool.read"] },
  // it.58 — brain.train : entraînement du cortex depuis le chat (exécuteur
  // réel lib/tools/brain-train.ts, invoqué en direct par engine-training).
  // Une définition manquait ici — un routage par le pipeline standard
  // levait une exception. Outil INTERNE (pas de réseau, pas de fichier).
  "brain.train": { name: "brain.train", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Médias générés (audit outils médias ; reclassification 10-10 — directive
  // « aucune approbation pour un outil interne »).
  // image.generate : génération d'image sur l'infrastructure Gen3ia (moteur
  // neuronal local — l'ancien service Agnes AI a été supprimé) — outil
  // INTERNE : aucune app utilisateur ciblée, aucun secret manipulé → jamais
  // de carte de validation. Ancienne classification « external » la forçait
  // dans le plan HITL (captures 07:24).
  "image.generate": { name: "image.generate", risk: "write", requiredPermissions: ["tool.write", "network.read"], network: true },
  // video.create : l'outil se contente d'ENCHERIR un job dans la file de
  // production interne (lib/video/production-queue) — la capacité est une
  // écriture interne (Firestore), comme schedule.create ; les appels
  // externes payants (Agnes) sont effectués par le PIPELINE aval, hors de
  // portée de l'outil lui-même. Décision : risque de sécurité « write » sans
  // flag réseau/externe ; le risque HITL « high » (action longue + payante →
  // carte de validation) est porté par la définition de l'outil dans
  // lib/tools — même convention documentée que schedule.*.
  "video.create": { name: "video.create", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // video.status : lecture pure du job de production (Firestore interne),
  // restreint au propriétaire — aucun flag réseau/externe.
  "video.status": { name: "video.status", risk: "read", requiredPermissions: ["tool.read"] },
  // video.revise : écrit le projet (versions, timeline, voix), pilote le
  // rendu et les exports — capacité d'écriture interne (Firestore), appels
  // externes éventuels (LLM de révision) effectués par le SERVICE aval.
  "video.revise": { name: "video.revise", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Task 140 — SUITE « OUTILS PILOTÉS PAR LES AGENTS IA » (16 outils).
  // Convention du dépôt : le profil de sécurité décrit la CAPABILITÉ ; le
  // risque HITL (carte de validation) est porté par la définition de l'outil
  // dans lib/tools + la politique d'approbation (directive 10-10 : les outils
  // internes ne déclenchent JAMAIS de carte).
  // Brief de relais IA → humain : LLM facturé + artefact persisté (stockage
  // Gen3ia) — opération INTERNE.
  "handover.compose": { name: "handover.compose", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Terminal protégé : MÊME canal sécurisé que terminal.run (deny-list durcie,
  // env nettoyé, /tmp éphémère) avec pré-analyse + auto-réparation bornée —
  // capacité d'écriture interne, gated par allowAgentTerminal (défense en
  // profondeur, identique à terminal.run).
  "terminal.shield": { name: "terminal.shield", risk: "write", requiredPermissions: ["tool.read", "tool.write"], filesystemWrite: true },
  // Recherche de packages en direct (registres npm/PyPI publics) : lecture
  // réseau pure, comme web.search.
  "registry.find": { name: "registry.find", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  // Auto-correction de build : crée une PULL REQUEST réelle sur GitHub avec
  // le token de la plateforme — action externe.
  "build.autofix": { name: "build.autofix", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  // Studio de simulation : LLM facturé + fetch optionnel de la page cible
  // (lecture) + rapport persisté — opération interne.
  "simulation.run": { name: "simulation.run", risk: "write", requiredPermissions: ["tool.read", "tool.write", "network.read"], network: true },
  // Navigation adaptative : lecture réseau (SSRF-gardée) comme web.open.
  "browser.navigate": { name: "browser.navigate", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  // Extraction structurée : fetch optionnel (lecture) + LLM facturé.
  "schema.extract": { name: "schema.extract", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  // Répondeur vocal : expédie email/SMS réels au nom de la plateforme —
  // action externe (gated validation humaine du flux HITL).
  "voicemail.respond": { name: "voicemail.respond", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  // Masquage déterministe : transformation pure en mémoire, aucun stockage.
  "transcript.redact": { name: "transcript.redact", risk: "read", requiredPermissions: ["tool.read"] },
  // Navigation IVR : analyse + plan DTMF (LLM facturé) — aucune écriture.
  "ivr.navigate": { name: "ivr.navigate", risk: "read", requiredPermissions: ["tool.read"] },
  // Webhook auto-réparateur : re-soumission POST vers un endpoint externe —
  // action externe (gated validation humaine du flux HITL).
  "webhook.heal": { name: "webhook.heal", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  // Watchdog : registre interne (Firestore) + fetch de la page surveillée
  // (lecture) — opération interne propriétaire-scopée.
  "watchdog.track": { name: "watchdog.track", risk: "write", requiredPermissions: ["tool.read", "tool.write", "network.read"], network: true },
  // Guide terminal : LLM facturé + artefact persisté — opération interne.
  "terminal.guide": { name: "terminal.guide", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Pipeline de contenu : LLM facturé + artefact persisté — opération interne.
  "content.package": { name: "content.package", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Graphe de connaissances : LLM facturé + artefact persisté — interne.
  "knowledge.graph": { name: "knowledge.graph", risk: "write", requiredPermissions: ["tool.read", "tool.write"] },
  // Moteur de décision : calcul pur déterministe en mémoire.
  "decision.analyze": { name: "decision.analyze", risk: "read", requiredPermissions: ["tool.read"] },
};

export function getToolSecurityDefinition(toolName: string): ToolSecurityDefinition { const definition = TOOL_SECURITY[toolName]; if (!definition) throw new Error(`Unknown tool security definition: ${toolName}`); return definition; }

/**
 * Ensemble des noms d'outils possédant une définition de sécurité réelle
 * (étape 7) : GEN3IA_TOOLS ne couvre pas les sous-services internes
 * (schedule.*, workflow.*) pourtant exécutables légitimement — toute
 * validation d'existence d'outil doit considérer l'UNION des deux sources.
 */
export const KNOWN_TOOL_SECURITY_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOL_SECURITY));

/** Extension tools follow the `ext.<extensionId>.<toolId>` naming convention. */
export function isExtensionToolName(toolName: string): boolean {
  return toolName.startsWith("ext.") && /^[a-z0-9-]+\.[a-z0-9_-]+$/i.test(toolName.slice(4));
}

function getExtensionToolSecurityDefinition(toolName: string): ToolSecurityDefinition {
  return { name: toolName, risk: "external", requiredPermissions: ["tool.external", "extension.execute"], network: true, externalApp: true };
}

export function authorizeTool(policy: ExecutionPolicy, toolName: string): ToolSecurityDefinition {
  assertToolAllowed(policy, toolName);
  // Extension tools carry their own security profile: network calls, external
  // risk class, and the dedicated `extension.execute` permission. All other
  // gates (emergency stop, quotas, audit, metering, guardrails) are applied by
  // the shared secure executor pipeline.
  if (isExtensionToolName(toolName)) {
    const extensionDefinition = getExtensionToolSecurityDefinition(toolName);
    for (const permission of extensionDefinition.requiredPermissions) assertPermission(policy, permission);
    if (!policy.allowNetwork) throw new Error(`Network access denied for tool: ${toolName}`);
    if (!policy.allowExternalApps) throw new Error(`External application access denied: ${toolName}`);
    return extensionDefinition;
  }
  const definition = getToolSecurityDefinition(toolName);
  for (const permission of definition.requiredPermissions) assertPermission(policy, permission);
  if (definition.network && !policy.allowNetwork) throw new Error(`Network access denied for tool: ${toolName}`);
  if (definition.externalApp && !policy.allowExternalApps) throw new Error(`External application access denied: ${toolName}`);
  if (definition.filesystemWrite && !policy.allowFileWrite) throw new Error(`Filesystem write denied: ${toolName}`);
  if (definition.destructive && !policy.allowFileDelete && !["code.execute", "terminal.execute"].includes(toolName)) throw new Error(`Destructive operation denied: ${toolName}`);
  if (toolName === "code.execute" && !policy.allowCodeExecution) throw new Error("Code execution denied by policy");
  if (toolName === "terminal.execute" && !policy.allowAgentTerminal) throw new Error("Agent terminal denied by policy");
  if (toolName === "terminal.run" && !policy.allowAgentTerminal) throw new Error("Agent terminal denied by policy");
  if (toolName === "terminal.shield" && !policy.allowAgentTerminal) throw new Error("Agent terminal denied by policy");
  if (toolName === "camera.capture" && !policy.allowCamera) throw new Error("Camera access denied by policy");
  return definition;
}
