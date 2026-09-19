import { getComposio } from "./client";
import { getAppUrl } from "@/lib/url/app-url";

export type AdsProvider = "google_ads" | "meta_ads" | "tiktok_ads";

export const ADS_COMPOSIO_TOOLKITS: Record<AdsProvider, string> = {
  google_ads: "googleads",
  meta_ads: "metaads",
  tiktok_ads: "tiktok_ads",
};

export function getAdsToolkit(provider: string): string {
  const toolkit = ADS_COMPOSIO_TOOLKITS[provider as AdsProvider];
  if (!toolkit) throw new Error(`Unsupported Ads provider: ${provider}`);
  return toolkit;
}

function assertAdsToolSlug(provider: AdsProvider, toolSlug: string) {
  if (!/^[A-Z0-9_:-]{3,200}$/i.test(toolSlug)) throw new Error("Invalid Ads Composio tool slug.");
  const expectedPrefixes: Record<AdsProvider, RegExp> = {
    google_ads: /^GOOGLEADS_/i,
    meta_ads: /^METAADS_/i,
    tiktok_ads: /^TIKTOK_ADS_/i,
  };
  if (!expectedPrefixes[provider].test(toolSlug)) throw new Error(`Tool ${toolSlug} does not belong to ${provider}.`);
}

export async function authorizeAdsProvider(userId: string, provider: string) {
  if (!userId) throw new Error("userId is required.");
  const toolkit = getAdsToolkit(provider);
  const callbackUrl = `${getAppUrl()}/studio?composio_connected=1&toolkit=${encodeURIComponent(toolkit)}`;

  const session = await getComposio().create(userId, {
    manageConnections: {
      enable: true,
      callbackUrl,
      waitForConnections: false,
    },
  });

  return session.authorize(toolkit, { callbackUrl });
}

export async function listAdsConnections(userId: string) {
  if (!userId) throw new Error("userId is required.");
  const result = await getComposio().connectedAccounts.list({ userIds: [userId] });
  return result.items
    .filter((account) => (Object.values(ADS_COMPOSIO_TOOLKITS) as string[]).includes(account.toolkit?.slug ?? ""))
    .map((account) => ({
      id: account.id,
      provider: Object.entries(ADS_COMPOSIO_TOOLKITS).find(([, toolkit]) => toolkit === account.toolkit?.slug)?.[0] ?? "unknown",
      toolkit: account.toolkit?.slug,
      status: account.status,
      enabled: !account.isDisabled,
    }));
}

export async function getAdsTools(userId: string, provider: string) {
  if (!userId) throw new Error("userId is required.");
  return getComposio().tools.get(userId, { toolkits: [getAdsToolkit(provider)] });
}

export async function executeAdsTool(params: {
  userId: string;
  provider: AdsProvider;
  toolSlug: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  if (!params.userId) throw new Error("userId is required.");
  if (!params.connectedAccountId || params.connectedAccountId.length > 256) throw new Error("A specific Ads connected account is required.");
  assertAdsToolSlug(params.provider, params.toolSlug);

  const composio = getComposio();
  const accounts = await composio.connectedAccounts.list({ userIds: [params.userId] });
  const account = accounts.items.find((item) => item.id === params.connectedAccountId);
  if (!account || account.isDisabled || account.status !== "ACTIVE") throw new Error("The requested Ads connected account is not active or does not belong to this user.");
  if (account.toolkit?.slug !== getAdsToolkit(params.provider)) throw new Error("The connected Ads account does not match the requested provider.");

  const tools = await composio.tools.get(params.userId, {
    toolkits: [getAdsToolkit(params.provider)],
    search: params.toolSlug,
    limit: 20,
  });
  const matchingTool = Array.isArray(tools) ? tools.find((tool) => (tool as { slug?: string }).slug === params.toolSlug) : undefined;
  if (!matchingTool) throw new Error("The requested Ads tool is not available for this connected account.");

  return composio.tools.execute(
    params.toolSlug,
    {
      userId: params.userId,
      connectedAccountId: params.connectedAccountId,
      arguments: params.arguments,
      dangerouslySkipVersionCheck: true,
    },
    {
      signal: params.signal,
    },
  );
}
