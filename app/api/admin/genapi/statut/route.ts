import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { statutGenAPI } from "@/lib/genapi/clients";
import { listerJournalGenAPI } from "@/lib/genapi/provisionnement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nombre d'entrées de journal renvoyées à la console (les plus récentes). */
const JOURNAL_LIMITE = 20;

/**
 * GET /api/admin/genapi/statut — santé du socle genAPI (admin uniquement).
 *
 * genAPI = Agent OS gRPC de gen3 : provisionnement de certificats clients
 * mTLS par le Master Daemon, paquets à usage unique, facturation Chariow à
 * l'exécution. La console admin lit ici l'état du CA racine, les compteurs
 * du jour et le journal des événements — jamais de secret (aucune clé, aucune
 * empreinte complète).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  try {
    const [statut, journal] = await Promise.all([statutGenAPI(), listerJournalGenAPI(JOURNAL_LIMITE)]);
    return NextResponse.json(
      { statut, journal, genereA: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Panne du socle (Firestore, daemon) : 500 propre avec code machine,
    // la console affiche un bandeau honnête au lieu de mentir sur la santé.
    return NextResponse.json(errorBody(error, "genAPI indisponible : impossible de lire le statut du socle."), { status: 500 });
  }
}
