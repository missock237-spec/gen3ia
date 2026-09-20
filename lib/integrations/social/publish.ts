import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getComposio } from "@/lib/integrations/composio/client";
import { billUsage } from "@/lib/billing/media-meter";

/**
 * Publication sociale planifiée — LinkedIn, X, Instagram, Facebook, Reddit,
 * YouTube, TikTok. L'authentification passe par les connexions OAuth
 * utilisateur établies dans le Connections Hub (/integrations) : l'outil
 * découvre l'action de publication du toolkit connecté, mappe le contenu
 * sur son paramètre principal puis exécute via Composio.
 */

export const SOCIAL_PLATFORM_TOOLKITS: Record<string, string> = {
  linkedin: "linkedin",
  x: "x",
  instagram: "instagram",
  facebook: "facebook",
  reddit: "reddit",
  youtube: "youtube",
  tiktok: "tiktok",
};

const POSTING_TOOL_RE = /(POST|TWEET|SHARE|PUBLISH|SEND|UPLOAD)/i;
const TEXT_FIELD_RE = /^(text|content|message|post|caption|body|title|tweet_text|text_content)/i;
const MEDIA_FIELD_RE = /(media|image|video|file|attachment|url)/i;

const InputSchema = z.object({
  platform: z.enum(["linkedin", "x", "instagram", "facebook", "reddit", "youtube", "tiktok"]),
  content: z.string().trim().min(1).max(5000),
  mediaUrl: z.string().url().max(2048).optional().describe("URL publique d'un média (image/vidéo) à joindre, si le toolkit connecté le supporte."),
  connectedAccountId: z.string().min(1).max(256).optional().describe("Connexion Composio à utiliser (défaut : la première connexion active pour cette plateforme)."),
});

export type SocialPublishInput = z.infer<typeof InputSchema>;

interface ComposioToolShape {
  slug?: string;
  inputParameters?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

function pickTextField(tool: ComposioToolShape): string | undefined {
  const properties = tool.inputParameters?.properties ?? {};
  const keys = Object.keys(properties);
  return keys.find((key) => TEXT_FIELD_RE.test(key)) ?? keys.find((key) => !MEDIA_FIELD_RE.test(key));
}

function pickMediaField(tool: ComposioToolShape): string | undefined {
  const properties = tool.inputParameters?.properties ?? {};
  return Object.keys(properties).find((key) => MEDIA_FIELD_RE.test(key));
}

async function resolveConnectedAccount(userId: string, toolkit: string, connectedAccountId?: string): Promise<string> {
  const composio = getComposio();
  const accounts = await composio.connectedAccounts.list({ userIds: [userId] });
  const eligible = accounts.items.filter(
    (account) => account.toolkit?.slug === toolkit && !account.isDisabled && account.status === "ACTIVE",
  );
  if (eligible.length === 0) {
    throw new Error(`Aucune connexion active pour "${toolkit}". Connectez la plateforme depuis /integrations.`);
  }
  if (connectedAccountId) {
    const selected = eligible.find((account) => account.id === connectedAccountId);
    if (!selected) throw new Error("La connexion fournie ne correspond pas à cette plateforme ou n'est pas active.");
    return selected.id;
  }
  return eligible[0].id;
}

async function findPostingTool(userId: string, toolkit: string): Promise<ComposioToolShape & { slug: string }> {
  const composio = getComposio();
  const tools = (await composio.tools.get(userId, { toolkits: [toolkit], search: "post", limit: 25 })) as unknown[];
  const candidates = (Array.isArray(tools) ? tools : []) as Array<ComposioToolShape & { slug?: string }>;
  const posting = candidates.find((tool) => typeof tool.slug === "string" && POSTING_TOOL_RE.test(tool.slug));
  if (!posting?.slug) {
    throw new Error(`Aucune action de publication disponible pour "${toolkit}". Vérifiez les permissions de la connexion.`);
  }
  return posting as ComposioToolShape & { slug: string };
}

export async function publishSocialContent(params: SocialPublishInput & { userId: string }): Promise<Record<string, unknown>> {
  if (!params.userId?.trim()) throw new Error("A user ID is required.");
  const toolkit = SOCIAL_PLATFORM_TOOLKITS[params.platform];
  if (!toolkit) throw new Error(`Plateforme non supportée : ${params.platform}`);

  const composio = getComposio();
  const connectedAccountId = await resolveConnectedAccount(params.userId, toolkit, params.connectedAccountId);
  const tool = await findPostingTool(params.userId, toolkit);

  const textField = pickTextField(tool);
  if (!textField) throw new Error(`L'action ${tool.slug} n'expose pas de paramètre de contenu identifiable.`);
  const arguments_: Record<string, unknown> = { [textField]: params.content };
  if (params.mediaUrl) {
    const mediaField = pickMediaField(tool);
    if (mediaField) arguments_[mediaField] = params.mediaUrl;
  }

  await billUsage({
    userId: params.userId,
    executionId: `social_${randomUUID()}`,
    kind: params.mediaUrl ? "social_video_publish" : "social_post",
    quantity: 1,
    metadata: { platform: params.platform, tool: tool.slug },
  });

  const result = await composio.tools.execute(
    tool.slug,
    { userId: params.userId, connectedAccountId, arguments: arguments_, dangerouslySkipVersionCheck: true },
    { signal: AbortSignal.timeout(30_000) },
  );
  return { platform: params.platform, tool: tool.slug, result };
}
