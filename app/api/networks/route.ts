import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { executionLogger, safeError } from "@/lib/observability/logger";
import { createNetwork, listNetworks } from "@/lib/agents/networks/repository";

/**
 * Réseaux d'agents persistants (concepts post-SaaS #3/#8) — collection.
 * GET  : liste des réseaux du propriétaire (orgId optionnel pour la vue organisation).
 * POST : création (membres validés : agents réels, actifs, accessibles).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const orgId = request.nextUrl.searchParams.get("orgId")?.trim() || undefined;
    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
    const networks = await listNetworks(user.uid, {
      ...(orgId ? { orgId } : {}),
      includeArchived,
    });
    return NextResponse.json({ networks });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Réseaux indisponibles" },
      { status: errorStatus(error, 500) },
    );
  }
}

export async function POST(request: NextRequest) {
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "networks-create" });
  try {
    const user = await requireUser(request);
    const body = await request.json();
    const network = await createNetwork(user.uid, body);
    log.info({ event: "network.created", networkId: network.id, userId: user.uid }, "Réseau créé");
    return NextResponse.json({ network }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Création impossible";
    log.warn({ event: "network.create.failed", error: safeError(error) }, "Création de réseau refusée");
    // Requête invalide (schéma/invariants/membre inexistant) = 400 ; une
    // organisation inaccessible est une 403 explicite via son message.
    const status = message.includes("Organisation") ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
