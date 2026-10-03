import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { listCapabilitiesForUser } from "@/lib/capabilities/catalog";

/**
 * CATALOGUE DE CAPACITÉS (concept post-SaaS #5 « AI Operating System ») :
 * la vue unifiée de tout ce que le principal peut faire exécuter — outils
 * natifs, extensions installées, APIs personnelles, serveurs MCP, équipes.
 * Lecture propriétaire-scopée, aucune écriture.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const kindFilter = request.nextUrl.searchParams.get("kind")?.trim();
    const catalog = await listCapabilitiesForUser(user.uid);
    if (kindFilter) {
      const filtered = catalog.capabilities.filter((entry) => entry.kind === kindFilter);
      return NextResponse.json({
        principal: catalog.principal,
        totalCount: filtered.length,
        byKind: catalog.byKind,
        capabilities: filtered,
      });
    }
    return NextResponse.json(catalog);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Catalogue indisponible" },
      { status: errorStatus(error, 500) },
    );
  }
}
