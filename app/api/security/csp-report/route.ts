import { NextRequest, NextResponse } from "next/server";

import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 16 * 1024;

function clip(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Retire requêtes/fragments d'URL (jetons potentiels) et caractères de contrôle.
  const cleaned = value.replace(/[?#].*$/, "").replace(/[\u0000-\u001f]/g, "");
  return cleaned.slice(0, max);
}

/**
 * POST /api/security/csp-report — collecte des violations de la politique
 * `Content-Security-Policy-Report-Only` (format report-uri historique ou
 * Reporting API). Public par nature (le navigateur l'appelle sans jeton),
 * donc limité en débit et en taille ; rien n'est renvoyé au client.
 */
export async function POST(request: NextRequest) {
  const limit = await enforceRateLimit(`csp-report:${clientIp(request)}`, { limit: 60, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) return new NextResponse(null, { status: 429 });

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_REPORT_BYTES) return new NextResponse(null, { status: 413 });

  try {
    const raw = await request.text();
    if (raw.length > MAX_REPORT_BYTES) return new NextResponse(null, { status: 413 });
    const parsed = JSON.parse(raw) as unknown;
    const entries = Array.isArray(parsed) ? parsed.slice(0, 10) : [parsed];
    for (const entry of entries) {
      const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const report = (record["csp-report"] ?? record.body ?? record) as Record<string, unknown>;
      console.warn("[csp-report]", JSON.stringify({
        directive: clip(report["violated-directive"] ?? report.effectiveDirective ?? report["effective-directive"], 80),
        blocked: clip(report["blocked-uri"] ?? report.blockedURL),
        document: clip(report["document-uri"] ?? report.documentURL),
        source: clip(report["source-file"] ?? report.sourceFile),
      }));
    }
  } catch {
    // Rapport illisible : ignoré silencieusement.
  }
  return new NextResponse(null, { status: 204 });
}
