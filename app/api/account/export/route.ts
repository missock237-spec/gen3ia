import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { exportAccountData } from "@/lib/privacy/account-export";

/**
 * GET /api/account/export — portabilité COMPLÈTE du compte (Job 478451,
 * it. 25) : mémoire personnalisée + conversations/messages + agents dans
 * un JSON portable auto-descriptif (manifest par namespace, caps honnêtes).
 *
 * Différence avec /api/memory/export (Task 42, conservé tel quel) : celui-ci
 * couvre TOUT le compte — c'est l'export « gouvernance des données » attendu
 * d'une plateforme de niveau entreprise. Réponse en pièce jointe
 * téléchargeable (Content-Disposition), jamais mise en cache.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, {
    key: "account-export",
    rateLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  });
  if (!guard.ok) return guard.response;
  let data: Awaited<ReturnType<typeof exportAccountData>>;
  try {
    data = await exportAccountData(guard.context.userId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export du compte impossible pour le moment." },
      { status: errorStatus(error, 500) },
    );
  }
  const stamp = data.exportedAt.slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="gen3ia-compte-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
