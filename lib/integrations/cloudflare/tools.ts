import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";

const CF_API = "https://api.cloudflare.com/client/v4";

function token(): string {
  const value = process.env.CLOUDFLARE_API_TOKEN;
  if (!value) throw new Error("CLOUDFLARE_API_TOKEN is not configured.");
  return value;
}

async function cfFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = (await response.json()) as { success?: boolean; errors?: Array<{ code: number; message: string }>; result?: T };
  if (!response.ok || !data.success) {
    const message = (data.errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new Error(`Cloudflare API ${response.status}: ${message || "unknown error"}`);
  }
  return data.result as T;
}

interface Zone { id: string; name: string; status: string; account?: { id?: string } }
interface DnsRecord { id: string; type: string; name: string; content: string; proxied?: boolean; ttl: number }

const ZonesListInput = z.object({
  maxResults: z.number().int().min(1).max(50).default(10),
});

export const cloudflareZonesListTool: ToolDefinition<z.infer<typeof ZonesListInput>, unknown> = {
  id: "cloudflare.zones.list",
  name: "cloudflare.zones.list",
  description: "List the Cloudflare zones (domains) accessible to the integration token.",
  category: "http",
  risk: "low",
  inputSchema: ZonesListInput,
  async execute(input) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const params = new URLSearchParams({ per_page: String(input.maxResults) });
    if (accountId) params.set("account.id", accountId);
    const zones = await cfFetch<Zone[]>(`/zones?${params.toString()}`);
    return { zones: zones.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status })) };
  },
};

const DnsListInput = z.object({
  zoneName: z.string().min(3).max(200),
  maxResults: z.number().int().min(1).max(100).default(25),
});

export const cloudflareDnsListTool: ToolDefinition<z.infer<typeof DnsListInput>, unknown> = {
  id: "cloudflare.dns.list",
  name: "cloudflare.dns.list",
  description: "List DNS records of a Cloudflare zone by domain name.",
  category: "http",
  risk: "low",
  inputSchema: DnsListInput,
  async execute(input) {
    const zones = await cfFetch<Zone[]>(`/zones?name=${encodeURIComponent(input.zoneName)}`);
    const zone = zones[0];
    if (!zone) throw new Error(`Zone not found or not authorized: ${input.zoneName}`);
    const records = await cfFetch<DnsRecord[]>(`/zones/${zone.id}/dns_records?per_page=${input.maxResults}`);
    return {
      zone: { id: zone.id, name: zone.name },
      records: records.map((record) => ({ id: record.id, type: record.type, name: record.name, content: record.content, proxied: record.proxied ?? false, ttl: record.ttl })),
    };
  },
};

const DnsCreateInput = z.object({
  zoneName: z.string().min(3).max(200),
  type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX"]),
  name: z.string().min(1).max(253),
  content: z.string().min(1).max(4096),
  ttl: z.number().int().min(60).max(86400).default(3600),
  proxied: z.boolean().default(false),
  priority: z.number().int().min(0).max(65535).optional(),
});

export const cloudflareDnsCreateTool: ToolDefinition<z.infer<typeof DnsCreateInput>, unknown> = {
  id: "cloudflare.dns.create",
  name: "cloudflare.dns.create",
  description: "Create a DNS record in an authorized Cloudflare zone. External side effect.",
  category: "http",
  risk: "high",
  inputSchema: DnsCreateInput,
  async execute(input) {
    const zones = await cfFetch<Zone[]>(`/zones?name=${encodeURIComponent(input.zoneName)}`);
    const zone = zones[0];
    if (!zone) throw new Error(`Zone not found or not authorized: ${input.zoneName}`);
    const record = await cfFetch<DnsRecord>(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      }),
    });
    return { id: record.id, name: record.name, type: record.type, content: record.content };
  },
};
