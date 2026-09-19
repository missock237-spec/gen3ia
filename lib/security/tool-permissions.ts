import { ExecutionPolicy, Permission, ToolRisk, assertPermission, assertToolAllowed } from "./execution-policy";

export interface ToolSecurityDefinition { name: string; risk: ToolRisk; requiredPermissions: Permission[]; network?: boolean; filesystemRead?: boolean; filesystemWrite?: boolean; destructive?: boolean; externalApp?: boolean; }

const TOOL_SECURITY: Record<string, ToolSecurityDefinition> = {
  "web.search": { name: "web.search", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "web.open": { name: "web.open", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "file.read": { name: "file.read", risk: "read", requiredPermissions: ["tool.read", "file.read"], filesystemRead: true },
  "file.create": { name: "file.create", risk: "write", requiredPermissions: ["tool.write", "file.create", "file.write"], filesystemWrite: true },
  "file.modify": { name: "file.modify", risk: "write", requiredPermissions: ["tool.write", "file.write"], filesystemWrite: true },
  "file.delete": { name: "file.delete", risk: "destructive", requiredPermissions: ["tool.destructive", "file.delete"], filesystemWrite: true, destructive: true },
  "zip.analyze": { name: "zip.analyze", risk: "read", requiredPermissions: ["tool.read", "file.read"], filesystemRead: true },
  "zip.create": { name: "zip.create", risk: "write", requiredPermissions: ["tool.write", "file.write"], filesystemRead: true, filesystemWrite: true },
  "zip.extract": { name: "zip.extract", risk: "write", requiredPermissions: ["tool.write", "file.write", "file.create"], filesystemRead: true, filesystemWrite: true },
  "artifact.create": { name: "artifact.create", risk: "write", requiredPermissions: ["tool.write", "file.write"], filesystemRead: true, filesystemWrite: true },
  "artifact.download": { name: "artifact.download", risk: "read", requiredPermissions: ["tool.read", "file.read"] },
  "composio.execute": { name: "composio.execute", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "code.execute": { name: "code.execute", risk: "destructive", requiredPermissions: ["code.execute"] },
  "ui.components": { name: "ui.components", risk: "read", requiredPermissions: ["tool.external", "network.read"], network: true },
  "terminal.execute": { name: "terminal.execute", risk: "destructive", requiredPermissions: ["terminal.execute"] },
  "memory.read": { name: "memory.read", risk: "read", requiredPermissions: ["tool.read", "memory.read"] },
  "memory.write": { name: "memory.write", risk: "write", requiredPermissions: ["tool.write", "memory.write"] },
  "camera.capture": { name: "camera.capture", risk: "external", requiredPermissions: ["tool.external", "camera.capture"], externalApp: true },
  "ads.read": { name: "ads.read", risk: "read", requiredPermissions: ["tool.read", "ads.read", "network.read"], network: true, externalApp: true },
  "ads.publish": { name: "ads.publish", risk: "external", requiredPermissions: ["tool.external", "tool.write", "ads.write", "network.write"], network: true, externalApp: true },
  "github.create_repository": { name: "github.create_repository", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "voice.speak": { name: "voice.speak", risk: "external", requiredPermissions: ["tool.external", "network.read"], network: true },
  "voice.list": { name: "voice.list", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "phone.call": { name: "phone.call", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "notion.search": { name: "notion.search", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "notion.create_page": { name: "notion.create_page", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "jules.create_task": { name: "jules.create_task", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
  "jules.get_task": { name: "jules.get_task", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "cloudflare.zones.list": { name: "cloudflare.zones.list", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "cloudflare.dns.list": { name: "cloudflare.dns.list", risk: "read", requiredPermissions: ["tool.read", "network.read"], network: true },
  "cloudflare.dns.create": { name: "cloudflare.dns.create", risk: "external", requiredPermissions: ["tool.external", "tool.write", "network.write"], network: true, externalApp: true },
};

export function getToolSecurityDefinition(toolName: string): ToolSecurityDefinition { const definition = TOOL_SECURITY[toolName]; if (!definition) throw new Error(`Unknown tool security definition: ${toolName}`); return definition; }

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
  if (toolName === "camera.capture" && !policy.allowCamera) throw new Error("Camera access denied by policy");
  return definition;
}
