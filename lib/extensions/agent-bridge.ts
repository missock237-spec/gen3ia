import { extensionToolName } from "./runtime";
import { listInstalledExtensions, getLatestApprovedVersion, getExtension } from "./repository";
import { canUseExtension, pricingFromManifest } from "./pricing";
import { getEntitlement } from "./repository";

/**
 * Agent bridge: automatic discovery of installed extension capabilities.
 *
 * The orchestrator calls `getInstalledExtensionCapabilities(userId)` before
 * running a plan. Only extensions that are (1) installed & active for THIS
 * user, (2) approved on the platform and (3) covered by a valid
 * entitlement are exposed — nothing else ever reaches the agent.
 */

export interface ExtensionToolCapability {
  toolName: string;
  extensionId: string;
  toolId: string;
  name: string;
  description: string;
}

export interface ExtensionSkillCapability {
  extensionId: string;
  skillId: string;
  name: string;
  description: string;
  instructions: string;
}

export interface ExtensionWorkflowCapability {
  extensionId: string;
  workflowId: string;
  name: string;
  description: string;
}

export interface ExtensionCapabilities {
  tools: ExtensionToolCapability[];
  skills: ExtensionSkillCapability[];
  workflows: ExtensionWorkflowCapability[];
}

export async function getInstalledExtensionCapabilities(userId: string): Promise<ExtensionCapabilities> {
  const capabilities: ExtensionCapabilities = { tools: [], skills: [], workflows: [] };
  if (!userId?.trim()) return capabilities;

  const installations = await listInstalledExtensions(userId);
  const seen = new Set<string>();

  for (const installation of installations) {
    if (seen.has(installation.extensionId)) continue;
    seen.add(installation.extensionId);

    try {
      const extension = await getExtension(installation.extensionId);
      if (!extension || extension.status !== "approved") continue;
      const version = await getLatestApprovedVersion(installation.extensionId);
      if (!version || version.status !== "approved") continue;

      // Entitlement gate (free models always pass).
      const entitlement = await getEntitlement(installation.extensionId, userId);
      const access = canUseExtension(pricingFromManifest(version.manifest), entitlement);
      if (!access.allowed) continue;

      const permissionsGranted = new Set(installation.permissionsGranted);

      for (const tool of version.manifest.tools ?? []) {
        // A tool is only exposed when every host it touches is granted.
        const toolPermissions = version.manifest.permissions.filter(
          (permission) => permission.startsWith("http.fetch:") && permissionsGranted.has(permission),
        );
        const neededHosts = new Set(
          version.manifest.permissions.filter((permission) => permission.startsWith("http.fetch:")),
        );
        const allGranted = [...neededHosts].every((permission) => permissionsGranted.has(permission));
        if (!allGranted && toolPermissions.length === 0) continue;
        capabilities.tools.push({
          toolName: extensionToolName(installation.extensionId, tool.id),
          extensionId: installation.extensionId,
          toolId: tool.id,
          name: tool.name,
          description: tool.description,
        });
      }

      for (const skill of version.manifest.skills ?? []) {
        capabilities.skills.push({
          extensionId: installation.extensionId,
          skillId: skill.id,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
        });
      }

      for (const workflow of version.manifest.workflows ?? []) {
        capabilities.workflows.push({
          extensionId: installation.extensionId,
          workflowId: workflow.id,
          name: workflow.name,
          description: workflow.description,
        });
      }
    } catch {
      // A broken extension must never break the core agent flow.
      continue;
    }
  }

  return capabilities;
}

/**
 * Builds the policy addendum for the orchestrator: allowed tool names plus a
 * compact instruction block describing installed extension skills/workflows.
 */
export async function buildExtensionPolicyAddendum(userId: string): Promise<{
  toolNames: string[];
  contextBlock: string;
}> {
  const capabilities = await getInstalledExtensionCapabilities(userId);
  const lines: string[] = [];
  if (capabilities.skills.length > 0) {
    lines.push("Compétences fournies par des extensions installées :");
    for (const skill of capabilities.skills.slice(0, 8)) {
      lines.push(`- [${skill.extensionId}/${skill.skillId}] ${skill.name} : ${skill.description}`);
      lines.push(`  Instructions: ${skill.instructions.slice(0, 1_200)}`);
    }
  }
  if (capabilities.workflows.length > 0) {
    lines.push("Workflows d'extension disponibles (exécutables via l'API des extensions) :");
    for (const workflow of capabilities.workflows.slice(0, 8)) {
      lines.push(`- [${workflow.extensionId}/${workflow.workflowId}] ${workflow.name} : ${workflow.description}`);
    }
  }
  return {
    toolNames: capabilities.tools.map((tool) => tool.toolName),
    contextBlock: lines.join("\n"),
  };
}
