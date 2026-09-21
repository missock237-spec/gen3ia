import { createHash, randomUUID } from "node:crypto";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";

/**
 * Sources de veille des agents « toujours actifs » : RSS ou page web.
 * Le contenu est normalisé (on retire les zones volatiles : dates de
 * publication RSS, scripts, styles, espaces) puis haché en SHA-256 —
 * un changement de hash signifie « quelque chose de nouveau à traiter ».
 */

export type WatchSourceType = "rss" | "web";

export interface WatchSource {
  id: string;
  type: WatchSourceType;
  url: string;
  label?: string;
  lastHash?: string;
  lastCheckedAt?: string;
}

export interface WatchSourceSnapshot {
  sourceId: string;
  hash: string;
  changed: boolean;
  firstCheck: boolean;
  contentLength: number;
}

const FETCH_TIMEOUT_MS = 12_000;

/** Normalise le contenu brut : retire les zones qui changent sans réel contenu. */
export function normalizeSourceContent(type: WatchSourceType, raw: string): string {
  let text = raw;
  if (type === "rss") {
    text = text
      .replace(/<(lastBuildDate|pubDate|updated|published|dc:date|atom:updated|atom:published)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<(lastBuildDate|pubDate|updated|published|dc:date)[^>]*\/>/gi, "");
  } else {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  }
  return text
    .replace(/\s+/g, " ")
    .trim();
}

export function hashSourceContent(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 40);
}

/** Évalue une source : fetch public + hash normalisé + comparaison au précédent. */
export async function checkWatchSource(source: WatchSource, fetchImpl: typeof fetch = fetch): Promise<WatchSourceSnapshot> {
  const url = await assertPublicHttpUrl(source.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { "user-agent": "Gen3iaAgent/1.0 (+https://gen3ia.online)", accept: typeToAccept(source.type) },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(error instanceof Error && error.name === "AbortError"
      ? `Source « ${sourceLabel(source)} » : délai dépassé.`
      : `Source « ${sourceLabel(source)} » injoignable.`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Source « ${sourceLabel(source)} » a répondu ${response.status}.`);
  }
  const raw = (await response.text()).slice(0, 2_000_000);
  const hash = hashSourceContent(normalizeSourceContent(source.type, raw));
  return {
    sourceId: source.id,
    hash,
    changed: source.lastHash !== undefined && source.lastHash !== hash,
    firstCheck: source.lastHash === undefined,
    contentLength: raw.length,
  };
}

/** Crée une nouvelle source de veille (id serveur). */
export function createWatchSource(input: { type: WatchSourceType; url: string; label?: string }): WatchSource {
  return {
    id: randomUUID(),
    type: input.type,
    url: input.url,
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 120) } : {}),
  };
}

export function sourceLabel(source: WatchSource): string {
  return source.label || source.url;
}

function typeToAccept(type: WatchSourceType): string {
  return type === "rss"
    ? "application/rss+xml, application/xml, text/xml, */*"
    : "text/html, */*";
}
