import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  entrainerDeveloppementWeb,
  lireRapportWebdev,
  type RapportEntrainementWebdev,
} from "@/lib/neural/training/entrainement-webdev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CorpsEntrainementWebdev {
  plafondSnn?: number;
  plafondCortex?: number;
  epoques?: number;
}

/**
 * POST /api/admin/entrainement/webdev — lance l'entraînement web-dev RÉEL
 * (pack gen3-webdev-pack : des millions de lignes bilingues de développement
 * web — création de SaaS, sites web, projets complets) et retourne le rapport
 * honnête (métriques mesurées : discrimination du SNN sur données tenues à
 * l'écart, paires réellement ajoutées au cortex, rétention mesurée).
 *
 * Corps optionnel : { plafondSnn, plafondCortex, epoques } — plafonds de
 * production par défaut (2 000 SNN régime équilibré / 60 000 cortex / 3 époques).
 *
 * Idempotent : les motifs déjà connus du cortex sont ignorés ; le SNN
 * renforce la plasticité du pool DOM_DEVELOPPEMENT_WEB. Le cerveau est
 * sauvegardé après apprentissage effectif.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  let corps: CorpsEntrainementWebdev = {};
  try {
    corps = (await request.json()) as CorpsEntrainementWebdev;
  } catch {
    // Corps absent : plafonds de production par défaut.
  }

  const rapport = await entrainerDeveloppementWeb({
    plafondSnn: corps.plafondSnn,
    plafondCortex: corps.plafondCortex,
    epoques: corps.epoques,
  });

  return NextResponse.json(
    { ok: rapport.statut !== "echec", statut: rapport.statut, message: rapport.message, rapport },
    { status: rapport.statut === "echec" ? 503 : 200 },
  );
}

/**
 * GET /api/admin/entrainement/webdev — dernier rapport persisté (null si
 * aucun entraînement n'a encore été exécuté — jamais inventé).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const rapport: RapportEntrainementWebdev | null = await lireRapportWebdev();
  return NextResponse.json({ ok: rapport !== null, rapport });
}
