import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@/lib/tools/types";
import { getAdsTools } from "./ads";

const InputSchema = z.object({
  provider: z.enum(["google_ads", "meta_ads", "tiktok_ads"]),
});

function compactTool(tool: unknown) {
  const value = tool as Record<string, unknown>;
  const toolkit = value.toolkit as Record<string, unknown> | undefined;
  return {
    slug: typeof value.slug === "string" ? value.slug : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    description:
      typeof value.description === "string"
        ? value.description.slice(0, 2000)
        : undefined,
    toolkit:
      typeof toolkit?.slug === "string" ? toolkit.slug : undefined,
  };
}

export const adsReadTool: ToolDefinition<
  z.infer<typeof InputSchema>,
  unknown
> = {
  id: "ads.read",
  name: "Ads Tool Discovery",
  description:
    "Discover the read and management tools available for a connected Google Ads, Meta Ads, or TikTok Ads account through Composio. This tool never publishes an ad.",
  category: "composio",
  risk: "low",
  inputSchema: InputSchema,
  async execute(input: z.infer<typeof InputSchema>, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const tools = await getAdsTools(context.userId, input.provider);
    if (!Array.isArray(tools)) return tools;
    return tools.map(compactTool).slice(0, 200);
  },
};
