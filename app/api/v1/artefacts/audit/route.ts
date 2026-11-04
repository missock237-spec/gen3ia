import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { errorStatus } from "@/lib/security/http-errors";
import { auditerArtefact, estTypeArtefact, TYPES_ARTEFACTS, tailleMaxArtefact } from "@/lib/agents-os/artefacts/service-audit";

/**
 * POST /api/v1/artefacts/audit — DROP-AND-FIX EN 1 CLIC (Module 3).
 *
 * Entrée : { type: "json"|"yaml"|"docker-compose"|"nginx"|"javascript"|"typescript",
 *            contenu: string }.
 * Sortie : rapport HONNÊTE — erreurs initiales localisées (ligne/colonne),
 * réparations structurelles appliquées, fichier corrigé REVALIDÉ, erreurs
 * restantes éventuelles (aucune réparation simulée).
 *
 * Auth : clé développeur `g3a_` (Bearer ou x-api-key) via franchirPorteV1.
 * Limite : 1 Mo de contenu, 30 appels/min par clé.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const porte = await franchirPorteV1(request, "artefacts-audit", { limit: 30, windowMs: 60_000 });

    const brut = await request.text();
    if (brut.length > tailleMaxArtefact() + 1_000) {
      return NextResponse.json(
        { error: `payload dépasse la limite (${tailleMaxArtefact()} octets de contenu)`, requestId },
        { status: 413, headers: entete(requestId, porte.enTetesLimite) },
      );
    }

    let contrat: { type?: unknown; contenu?: unknown };
    try {
      contrat = JSON.parse(brut) as { type?: unknown; contenu?: unknown };
    } catch {
      return NextResponse.json(
        { error: "payload n'est pas un JSON valide", requestId },
        { status: 400, headers: entete(requestId, porte.enTetesLimite) },
      );
    }

    const type = typeof contrat.type === "string" ? contrat.type : "";
    const contenu = typeof contrat.contenu === "string" ? contrat.contenu : "";

    if (!estTypeArtefact(type)) {
      return NextResponse.json(
        { error: `type « ${type.slice(0, 32) || "absent"} » inconnu — types : ${TYPES_ARTEFACTS.join(", ")}`, requestId },
        { status: 400, headers: entete(requestId, porte.enTetesLimite) },
      );
    }
    if (!contenu.trim()) {
      return NextResponse.json(
        { error: "contenu vide — rien à auditer", requestId },
        { status: 400, headers: entete(requestId, porte.enTetesLimite) },
      );
    }

    const rapport = await auditerArtefact({ type, contenu });
    return NextResponse.json(
      { ...rapport, identite: porte.identite.userId, requestId },
      { status: 200, headers: entete(requestId, porte.enTetesLimite) },
    );
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "erreur interne", requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}

function entete(requestId: string, limite: Record<string, string>): Record<string, string> {
  return { "x-request-id": requestId, ...limite };
}
