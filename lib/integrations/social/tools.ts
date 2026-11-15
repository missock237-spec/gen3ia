import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@/lib/tools/types";
import { publishSocialContent } from "./publish";

const InputSchema = z.object({
  platform: z.enum(["linkedin", "x", "instagram", "facebook", "reddit", "youtube", "tiktok"]),
  content: z.string().trim().min(1).max(5000),
  mediaUrl: z.string().url().max(2048).optional(),
  connectedAccountId: z.string().min(1).max(256).optional(),
});

export const socialPublishTool: ToolDefinition<z.infer<typeof InputSchema>, unknown> = {
  id: "social.publish",
  name: "social.publish",
  description:
    "Publie un contenu sur LinkedIn, X, Instagram, Facebook, Reddit, YouTube ou TikTok via la connexion OAuth établie par l'utilisateur dans le Hub de Connexions. La publication est facturée au wallet.",
  category: "composio",
  risk: "high",
  inputSchema: InputSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    return publishSocialContent({ ...input, userId: context.userId });
  },
};
