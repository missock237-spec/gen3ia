const DEFAULT_APP_URL = "https://gen3ia.online";

function normalize(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_APP_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      return DEFAULT_APP_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_APP_URL;
  }
}

/**
 * Canonical public origin used for OAuth/webhook callbacks.
 * Production must never derive OAuth redirect URIs from a Vercel preview
 * hostname or an arbitrary Host header.
 */
export function getAppUrl(): string {
  return normalize(
    process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "") ||
      DEFAULT_APP_URL,
  );
}
