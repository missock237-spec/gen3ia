import {
  createHash,
} from "crypto";

import {
  ResearchSource,
} from "./types";

export interface RawSearchResult {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export function normalizeSearchResult(
  result: RawSearchResult,
): ResearchSource {
  const url =
    normalizeUrl(result.url);

  const domain =
    new URL(url).hostname
      .replace(/^www\./, "");

  return {
    id: createHash("sha256")
      .update(url)
      .digest("hex")
      .slice(0, 24),

    url,

    title:
      result.title ??
      domain,

    domain,

    snippet:
      result.snippet,

    publishedAt:
      result.publishedAt,

    accessedAt:
      new Date().toISOString(),

    sourceType:
      classifyDomain(domain),

    authorityScore:
      authorityScore(domain),

    relevanceScore: 0,

    freshnessScore: 0,

    verified: false,
  };
}

function normalizeUrl(
  raw: string,
): string {
  const url =
    new URL(raw);

  url.hash = "";

  for (
    const parameter of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
    ]
  ) {
    url.searchParams.delete(
      parameter,
    );
  }

  return url.toString();
}

/**
 * Comparaison d'hôte EXACTE (hôte ou sous-domaine du domaine de référence) :
 * les sous-chaînes (`includes`) faisaient correspondre
 * « evil-github.com.evil.io » à github.com (alertes CodeQL
 * incomplete-url-substring-sanitization) — un hôte ne peut plus être
 * reconnu qu'en entier, délimité par des points.
 */
function hostIs(
  domain: string,
  reference: string,
): boolean {
  return domain === reference || domain.endsWith(`.${reference}`);
}

function classifyDomain(
  domain: string,
): ResearchSource["sourceType"] {
  if (
    domain === "gov" ||
    domain.endsWith(".gov") ||
    domain.endsWith(".gov.uk")
  ) {
    return "official";
  }

  if (
    hostIs(domain, "github.com") ||
    hostIs(domain, "readthedocs.io") ||
    domain.startsWith("developer.")
  ) {
    return "documentation";
  }

  if (
    hostIs(domain, "arxiv.org") ||
    hostIs(domain, "nature.com") ||
    hostIs(domain, "acm.org")
  ) {
    return "academic";
  }

  if (
    hostIs(domain, "reddit.com") ||
    hostIs(domain, "stackoverflow.com")
  ) {
    return "community";
  }

  return "unknown";
}

function authorityScore(
  domain: string,
): number {
  if (
    domain.endsWith(".gov") ||
    domain.endsWith(".edu")
  ) {
    return 0.95;
  }

  if (
    hostIs(domain, "github.com") ||
    hostIs(domain, "openai.com") ||
    hostIs(domain, "google.com")
  ) {
    return 0.9;
  }

  if (
    hostIs(domain, "arxiv.org")
  ) {
    return 0.9;
  }

  return 0.5;
}
