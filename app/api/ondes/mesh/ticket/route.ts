import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus, forbidden, HttpError } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

import { creerTicketMesh, salleMeshPour, TICKET_MESH_TTL_MS } from "@/lib/ondes/mesh-prive";
import { requirePlanEntitlement, hasPlanEntitlement } from "@/lib/billing/abonnements";

/**
 * TICKETS D'ADMISSION DU MESH PRIVÉ (Private Mesh, plan Entreprise).
 *
 * POST /api/ondes/mesh/ticket — délivre un ticket signé (HMAC-SHA256,
 * TTL 10 min) pour rejoindre la salle privée `mesh-<empreinte-uid>` de
 * l'essaim. Le compte Entreprise (entitlement `private_mesh`) en fait
 * ce qu'il veut : chaque poste du parc demande son ticket avec LE MÊME
 * compte, et tous les postes se découvrent en WebRTC direct — aucun
 * paquet d'ondes ne transite par le serveur, aucune donnée ne sort du
 * parc.
 *
 * GET /api/ondes/mesh/ticket — statut : éligibilité du compte et salle
 * privée associée (sans délivrer de ticket).
 */

export const dynamic = "force-dynamic";

/** Anti-abus : même un compte légitime ne peut pas inonder l'émetteur. */
const LIMITE_TICKETS = { limit: 10, windowMs: 60 * 60 * 1000 } as const;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  try {
    const user = await requireUser(request);

    const decision = await enforceRateLimit(`mesh-ticket:${user.uid}`, LIMITE_TICKETS);
    if (!decision.allowed) {
      const secondes = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new HttpError(429, `Trop de tickets demandés : réessayez dans ${secondes} s.`, "RATE_LIMITED");
    }

    try {
      await requirePlanEntitlement(user.uid, "private_mesh");
    } catch {
      throw forbidden("Le mesh privé est réservé au plan Entreprise. Voir /tarifs.");
    }

    const { ticket, salle, expireDansMs } = creerTicketMesh(user.uid);
    return NextResponse.json(
      { ticket, salle, expireDansMs, ttlMs: TICKET_MESH_TTL_MS, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Ticket de mesh indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  try {
    const user = await requireUser(request);
    const actif = await hasPlanEntitlement(user.uid, "private_mesh");
    return NextResponse.json(
      {
        actif,
        salle: actif ? salleMeshPour(user.uid) : null,
        ttlMs: TICKET_MESH_TTL_MS,
        requestId,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Statut de mesh indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
