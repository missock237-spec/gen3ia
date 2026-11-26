import { existsSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";

import { inventaireModulesGen3, routerVersModules } from "@/lib/gen3/modules/orchestrateur-modules";
import {
  MISSION_MODULES_GEN3,
  MODULES_GEN3,
  NB_MODULES_GEN3,
} from "@/lib/gen3/modules/modules-gen3";

/**
 * LES 12 MODULES GEN3 — inventaire honnête + routage à la demande (demande
 * propriétaire : architecture 12 modules orchestrés par Gen3 Core).
 *
 * GET /api/neural/modules        → les 12 modules (mission, niveau N1/N2/N3,
 *                                  organes réels vérifiés sur disque, outils
 *                                  réels) + santé d'organes.
 * GET /api/neural/modules?q=...  → en plus, le rapport de routage de la
 *                                  demande (module principal, secondaires,
 *                                  scores des 12, latence réelle).
 *
 * Données 100 % réelles : les organes sont vérifiés par fs.existsSync au
 * moment de l'appel ; le routage est déterministe (lib/gen3/modules).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);

    const tousChemins = MODULES_GEN3.flatMap((m) => m.organes);
    const organesAbsents = tousChemins.filter(
      (chemin) => !existsSync(join(process.cwd(), chemin)),
    );
    const inventaire = inventaireModulesGen3(organesAbsents);

    const q = request.nextUrl.searchParams.get("q");
    const routage = q && q.trim().length > 0 ? routerVersModules(q) : null;

    return NextResponse.json({
      mission: MISSION_MODULES_GEN3,
      nbModules: NB_MODULES_GEN3,
      santeOrganes: {
        total: tousChemins.length,
        verifies: tousChemins.length - organesAbsents.length,
        absents: organesAbsents,
      },
      modules: inventaire.map((m) => ({
        id: m.id,
        label: m.label,
        mission: m.mission,
        niveau: m.niveau,
        nbOrganes: m.organes.length,
        organesVerifies: m.organesVerifies,
        organesAbsents: m.organesAbsents,
        outils: m.outils,
      })),
      routage,
    });
  } catch (error) {
    return errorStatus(error);
  }
}
