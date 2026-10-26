import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { listCapabilitiesForUser } from "@/lib/capabilities/catalog";
import { professeurDisponible } from "@/lib/neural/professeur-media";

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
    const base = {
      principal: catalog.principal,
      // PROFESSEUR MÉDIA TEMPORAIRE (loi CONTRAINTE-ONDES) : statut de
      // l'échafaudage image/voix/vidéo — diagnostic sans accès SSH.
      professeurMedia: professeurDisponible(),
    };
    if (kindFilter) {
      const filtered = catalog.capabilities.filter((entry) => entry.kind === kindFilter);
      return NextResponse.json({
        ...base,
        totalCount: filtered.length,
        byKind: catalog.byKind,
        capabilities: filtered,
      });
    }
    return NextResponse.json({ ...base, ...catalog });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Catalogue indisponible" },
      { status: errorStatus(error, 500) },
    );
  }
}
