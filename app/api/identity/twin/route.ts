import { NextRequest, NextResponse } from "next/server";

import { badRequest, errorBody, errorStatus } from "@/lib/security/http-errors";
import { protectRoute } from "@/lib/security/route-guard";
import { TwinProfileSchema } from "@/lib/identity/schema";
import { getTwinProfile, updateTwinProfile } from "@/lib/identity/twin";
import { identityErrorStatus } from "@/lib/identity/service";

/**
 * Task 114-b — profil « Jumeau Créatif » de l'utilisateur (DONNÉE PRIVÉE).
 *
 * GET   /api/identity/twin → { twinProfile } (profil vide = {})
 * PATCH /api/identity/twin → { twinProfile } (fusion champ à champ ; une
 *                             chaîne vide efface le champ correspondant)
 *
 * - uid pris UNIQUEMENT du jeton (protectRoute : Bearer Firebase ou cookie
 *   de session signé) — cloisonnement propriétaire par construction ;
 * - le jumeau alimente le chat des agents, les missions, les prompts image
 *   et la voix de synthèse (voir lib/identity/twin.ts) ;
 * - erreurs : 400 requête invalide, 401 non authentifié, 404 identité non
 *   provisionnée, 422/503/500 selon la classification canonique du dépôt.
 */

export const runtime = "nodejs";

/** Statut canonique : IdentityError d'abord, classification générique ensuite. */
function twinErrorStatus(error: unknown): number {
  return identityErrorStatus(error) ?? errorStatus(error, 500);
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "identity-twin", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const twinProfile = await getTwinProfile(guard.context.userId);
    return NextResponse.json({ twinProfile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: twinErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await protectRoute(request, { key: "identity-twin", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const body: unknown = await request.json();
    // Validation préalable lisible (400 avec message FR) ; le service
    // revalide par le même schéma (défense en profondeur).
    const parsed = TwinProfileSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest("Profil du jumeau invalide : vérifiez les longueurs (2000 caractères max par texte, 12 valeurs max de 200 caractères).");
    }
    const twinProfile = await updateTwinProfile(guard.context.userId, parsed.data);
    return NextResponse.json({ twinProfile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: twinErrorStatus(error) });
  }
}
