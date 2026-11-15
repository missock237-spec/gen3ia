import { getConnection, type AdsProvider } from "./ad-connections";

export interface AdPublishRequest {
  provider: AdsProvider;
  userId: string;
  name: string;
  accountId: string;
  destinationUrl: string;
  primaryText: string;
  headline: string;
  imageUrl?: string;
  campaignId?: string;
  adGroupId?: string;
  creativeId?: string;
  dailyBudgetMinor?: number;
}

function assertUrl(value: string) { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol)) throw new Error("Ad destination must be an HTTP(S) URL."); }
async function jsonRequest(url: string, token: string, init: RequestInit = {}) { const response = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`Ads provider request failed (${response.status}).`); return data; }

export async function publishAd(params: AdPublishRequest) {
  if (!params.name.trim() || !params.primaryText.trim() || !params.headline.trim()) throw new Error("Ad name, primary text and headline are required.");
  assertUrl(params.destinationUrl);
  const connection = await getConnection(params.userId, params.provider); if (!connection) throw new Error(`No ${params.provider} account is connected.`);
  const accountId = params.accountId || connection.accountId; if (!accountId) throw new Error("An Ads account ID is required.");

  if (params.provider === "meta_ads") {
    const version = process.env.META_GRAPH_API_VERSION ?? "v23.0";
    const base = `https://graph.facebook.com/${version}`;
    let campaignId = params.campaignId;
    if (!campaignId) {
      const campaign = await jsonRequest(`${base}/act_${encodeURIComponent(accountId)}/campaigns`, connection.accessToken, { method: "POST", body: JSON.stringify({ name: params.name, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [] }) });
      campaignId = String(campaign.id);
    }
    if (!params.creativeId) throw new Error("Meta publishing requires a prepared creativeId for the final ad. Gen3ia intentionally keeps newly created ads PAUSED until the user/provider workflow enables them.");
    const ad = await jsonRequest(`${base}/act_${encodeURIComponent(accountId)}/ads`, connection.accessToken, { method: "POST", body: JSON.stringify({ name: params.name, adset_id: params.adGroupId, creative: { creative_id: params.creativeId }, status: "PAUSED" }) });
    return { provider: params.provider, campaignId, adId: String(ad.id), status: "PAUSED" };
  }

  if (params.provider === "google_ads") {
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!developerToken) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is required for Google Ads publishing.");
    const customerId = accountId.replace(/-/g, "");
    const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "");
    const headers: Record<string, string> = { "developer-token": developerToken };
    if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
    const body = { operations: [{ create: { campaign: { resourceName: `customers/${customerId}/campaigns/${Date.now()}`, name: params.name, status: "PAUSED", advertisingChannelType: "SEARCH", manualCpc: {} } } }] };
    const response = await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}:mutate`, { method: "POST", headers: { ...headers, authorization: `Bearer ${connection.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`Google Ads publishing failed (${response.status}).`);
    return { provider: params.provider, status: "PAUSED", result: data };
  }

  const endpoint = process.env.TIKTOK_ADS_PUBLISH_URL ?? "https://business-api.tiktok.com/open_api/v1.3/campaign/create/";
  const data = await jsonRequest(endpoint, connection.accessToken, { method: "POST", body: JSON.stringify({ advertiser_id: accountId, campaign_name: params.name, objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: Math.max(50, params.dailyBudgetMinor ?? 1000) / 100 }) });
  return { provider: params.provider, status: "PAUSED", result: data };
}
