import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { requireOrgContext } from "@/lib/tenants/organizations";
import { buildOrgUsageOverview } from "@/lib/observability/org-queries";

/**
 * Usage agrégé PAR ORGANISATION (saas-roadmap §3, Task 43) : exécutions,
 * coûts, tokens des membres de l'org, agrégés par agent / outil / jour.
 *
 * Accès : tout membre de l'organisation peut consulter la vue d'usage
 * (requireOrgContext vérifie l'appartenance) — les données sont agrégées
 * et ne contiennent aucun contenu conversationnel.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId")?.trim() ?? "";
    if (!orgId || orgId.length > 128) {
      return NextResponse.json({ error: "Paramètre orgId requis" }, { status: 400 });
    }

    // Garde d'appartenance : 404 uniforme si l'org est absente ou si
    // l'appelant n'en est pas membre (pas d'énumération d'orgs).
    await requireOrgContext(user.uid, orgId);

    const days = Number(url.searchParams.get("days") ?? "14");
    const overview = await buildOrgUsageOverview(orgId, {
      days: Number.isFinite(days) ? days : 14,
    });
    return NextResponse.json(overview, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Usage organisation indisponible";
    const status = /auth|session|user/i.test(message)
      ? 401
      : /introuvable|refus/i.test(message)
        ? 404
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
