import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { orchestrateurEssaim } from "@/lib/essaim-media/orchestrateur";
import { assurerBatteur, ondePorteuse } from "@/lib/essaim-media/onde-porteuse";
import type { TypeMédiaEssaim } from "@/lib/essaim-media/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/essaim/job — la REQUÊTE ENTRANTE d'un agent gen3.
 *
 * « À chaque requête l'agent la reçoit puis envoie à l'IA centrale » :
 * le hook chat soumet ici le job média (image photoréaliste / voix
 * humaine / vidéo haute qualité). L'IA centrale :
 *  1. DÉCOMPOSE la requête en fragments (vidéo = 6 keyframes parallèles,
 *     voix = segments de phrases, image = unitaire) ;
 *  2. SÉLECTIONNE les 5 meilleurs appareils (registre, score GPU) ;
 *  3. DISTRIBUE une part à chacun (onde SSE + battement POST).
 */

const KINDS: TypeMédiaEssaim[] = ["image", "voice", "video"];

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = (await request.json()) as {
      jobId?: string;
      conversationId?: string;
      kind?: string;
      prompt?: string;
      ratio?: string;
      durationSeconds?: number;
    };

    const kind = body.kind as TypeMédiaEssaim;
    if (!KINDS.includes(kind)) {
      return NextResponse.json(
        { success: false, error: "kind invalide (image|voice|video)." },
        { status: 400 },
      );
    }
    const conversationId = String(body.conversationId ?? "").slice(0, 128);
    const prompt = String(body.prompt ?? "").trim();
    if (!conversationId || !prompt) {
      return NextResponse.json(
        { success: false, error: "conversationId et prompt requis." },
        { status: 400 },
      );
    }

    assurerBatteur({
      surveiller: () => orchestrateurEssaim.surveiller(),
      attribuer: () => orchestrateurEssaim.attribuer(),
    });

    const job = orchestrateurEssaim.créerJob({
      conversationId,
      userId: guard.context.userId,
      kind,
      prompt,
      ratio: body.ratio ? String(body.ratio).slice(0, 8) : undefined,
      duréeSecondes: Number(body.durationSeconds) || undefined,
      jobIdOrigine: body.jobId ? String(body.jobId).slice(0, 64) : undefined,
    });

    if (!job) {
      return NextResponse.json(
        {
          success: false,
          error:
            "L'IA centrale est à pleine capacité (plafond de jobs actifs) — réessayez dans un instant.",
        },
        { status: 503 },
      );
    }

    // Distribution immédiate aux 5 meilleurs appareils disponibles.
    const confiés = orchestrateurEssaim.attribuer();
    for (const f of confiés) {
      if (!f.noeudId) continue;
      ondePorteuse.publier(
        f.génération > 0
          ? { type: "relance", noeudId: f.noeudId, fragment: f, noeudPerdu: "distribution" }
          : { type: "affectation", noeudId: f.noeudId, fragments: [f] },
      );
    }

    const équipe = new Set(confiés.map((f) => f.noeudId)).size;
    const enAttente = job.fragments.filter((f) => f.état === "en-attente").length;

    return NextResponse.json({
      success: true,
      jobId: job.jobId,
      kind,
      fragments: job.fragments.length,
      équipe,
      enAttente,
      message: enAttente > 0
        ? `Job accepté : ${job.fragments.length} part(s) à calculer, ${équipe} appareil(s) mobilisé(s)${enAttente > 0 ? `, ${enAttente} part(s) en file (essaim saturé ou sans GPU disponible)` : ""}.`
        : `Job accepté : ${job.fragments.length} part(s) confiée(s) à ${équipe} appareil(s).`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `Requête d'essaim rejetée : ${error instanceof Error ? error.message : "erreur"}`,
      },
      { status: 500 },
    );
  }
}
