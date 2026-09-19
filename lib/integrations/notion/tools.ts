import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = process.env.NOTION_API_VERSION ?? "2022-06-28";

function token(): string {
  const value = process.env.NOTION_API_TOKEN;
  if (!value) throw new Error("NOTION_API_TOKEN is not configured.");
  return value;
}

async function notionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion API ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<T>;
}

function plainText(rich?: Array<{ plain_text?: string }>): string {
  return (rich ?? []).map((part) => part.plain_text ?? "").join("");
}

const NotionSearchInput = z.object({
  query: z.string().min(1).max(200),
  maxResults: z.number().int().min(1).max(20).default(5),
});

export const notionSearchTool: ToolDefinition<z.infer<typeof NotionSearchInput>, unknown> = {
  id: "notion.search",
  name: "notion.search",
  description: "Search pages and databases in the user's authorized Notion workspace.",
  category: "database",
  risk: "low",
  inputSchema: NotionSearchInput,
  async execute(input) {
    const data = await notionFetch<{ results?: Array<Record<string, unknown>> }>("/search", {
      method: "POST",
      body: JSON.stringify({
        query: input.query,
        page_size: input.maxResults,
      }),
    });
    const results = (data.results ?? []).map((item) => {
      const record = item as {
        id?: string;
        object?: string;
        url?: string;
        properties?: Record<string, { title?: Array<{ plain_text?: string }>; rich_text?: Array<{ plain_text?: string }> }>;
      };
      const properties = record.properties ?? {};
      const titleField = Object.values(properties).find((property) => Array.isArray(property?.title));
      const textField = Object.values(properties).find((property) => Array.isArray(property?.rich_text));
      return {
        id: record.id,
        type: record.object,
        url: record.url,
        title: plainText(titleField?.title) || plainText(textField?.rich_text) || "(sans titre)",
      };
    });
    return { results, count: results.length };
  },
};

const NotionCreatePageInput = z.object({
  parentPageId: z.string().min(32).max(64),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
});

export const notionCreatePageTool: ToolDefinition<z.infer<typeof NotionCreatePageInput>, unknown> = {
  id: "notion.create_page",
  name: "notion.create_page",
  description: "Create a page in the authorized Notion workspace under a given parent page.",
  category: "database",
  risk: "medium",
  inputSchema: NotionCreatePageInput,
  async execute(input) {
    const children = input.content.split("\n").filter((line) => line.trim().length > 0).slice(0, 90).map((line) => ({
      object: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 2000) } }] },
    }));
    const data = await notionFetch<{ id?: string; url?: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: input.parentPageId },
        properties: { title: [{ type: "text", text: { content: input.title } }] },
        children,
      }),
    });
    return { id: data.id, url: data.url };
  },
};
