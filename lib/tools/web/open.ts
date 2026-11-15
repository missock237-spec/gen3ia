import { z } from "zod";
import type { ToolDefinition } from "../types";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { markupToText } from "@/lib/content/html-text";

const OpenInput = z.object({
  url: z.string().url(),
  maxCharacters: z.number().int().min(1000).max(50000).default(20000),
});

interface OpenResult { url: string; status: number; contentType: string; text: string; }

export const webOpenTool: ToolDefinition<z.infer<typeof OpenInput>, OpenResult> = {
  id: "web.open",
  name: "Open Web Page",
  description: "Retrieve and extract text from a public web page.",
  category: "web",
  risk: "low",
  inputSchema: OpenInput,
  async execute(input, context) {
    const initial = await assertPublicHttpUrl(input.url);
    let response = await fetch(initial, {
      redirect: "manual",
      headers: { "User-Agent": "Gen3ia-AI-Studio/1.0" },
      signal: context.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Web page returned a redirect without a location.");
      const redirected = await assertPublicHttpUrl(new URL(location, initial).toString());
      response = await fetch(redirected, {
        redirect: "manual",
        headers: { "User-Agent": "Gen3ia-AI-Studio/1.0" },
        signal: context.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new Error("Multiple redirects are not allowed.");
    }
    if (!response.ok) throw new Error("Web page returned " + response.status + ".");
    return extractResponse(response);
  },
};

async function extractResponse(response: Response): Promise<OpenResult> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) throw new Error("Unsupported content type: " + contentType);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 5_000_000) throw new Error("Web page exceeds the 5 MiB response limit.");
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > 5_000_000) throw new Error("Web page exceeds the 5 MiB response limit.");
  // Machine à états dédiée (une passe, balises imbriquées inertes) — la
  // chaîne de regex historique laissait des balises actives résiduelles
  // (alerte CodeQL bad-tag-filter).
  const text = markupToText(html).slice(0, 50000);
  return { url: response.url, status: response.status, contentType, text };
}

export async function openWebPage(url: string, maxCharacters = 20000): Promise<string> {
  const parsed = OpenInput.parse({ url, maxCharacters });
  const result = await webOpenTool.execute(parsed, { userId: "system" });
  return result.text;
}
