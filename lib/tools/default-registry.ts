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
import { githubCreateRepositoryTool } from "@/lib/integrations/github/tools";
import {
  voiceListTool,
  voiceSpeakTool,
} from "@/lib/integrations/elevenlabs/tools";
import { twentyFirstUiTool } from "@/lib/integrations/twentyfirst/tool";
import { phoneCallTool } from "@/lib/tools/phone/call";

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
  if (process.env.COMPOSIO_API_KEY) registry.register(createComposioTool());
  if (process.env.GITHUB_TOKEN) registry.register(githubCreateRepositoryTool);
  if (process.env.ELEVENLABS_API_KEY) {
    registry.register(voiceSpeakTool);
    registry.register(voiceListTool);
  }
  if (process.env.TWENTY_FIRST_API_KEY) registry.register(twentyFirstUiTool);
  return registry;
}
