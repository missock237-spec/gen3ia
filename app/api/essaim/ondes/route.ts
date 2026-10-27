import { NextRequest, NextResponse } from "next/server";

import { résoudreIdentitéNœud } from "@/lib/security/noeud-service";
import { registreEssaim } from "@/lib/essaim-media/registre";
import { orchestrateurEssaim } from "@/lib/essaim-media/orchestrateur";
import { assurerBatteur, ondePorteuse } from "@/lib/essaim-media/onde-porteuse";
import type { CapacitésNoeud, FragmentTravail } from "@/lib/essaim-media/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/essaim/ondes — BATTEMENT D'ONDE de l'agent gen3 (le « signal » qui
 * relie l'agent du navigateur à l'IA centrale).
 *
 * L'agent POST ses capacités GPU toutes les ~12 s :
 *  1. son nœud est créé/rafraîchi dans le registre central (score recalculé) ;
 *  2. la sentinelle balaye les ruptures (déconnexions brusques → relance) ;
 *  3. les fragments en attente sont distribués aux 5 meilleurs appareils ;
 *  4. la réponse porte les affectations DU nœud appelant (double ceinture
 *     avec le canal SSE — un agent qui ne capte pas l'onde SSE reste servi).
 */

const NOEUD_RE = /^[a-zA-Z0-9_-]{8,80}$/;

export async function POST(request: NextRequest) {
  const guard = await résoudreIdentitéNœud(request);
  if (!guard.ok) return guard.response;

  try {
    const body = (await request.json()) as {
      noeudId?: string;
      capacités?: CapacitésNoeud;
      fragmentId?: string;
    };
    const noeudId = String(body.noeudId ?? "");
    if (!NOEUD_RE.test(noeudId)) {
      return NextResponse.json(
        { success: false, error: "Identifiant de nœud invalide." },
        { status: 400 },
      );
    }

    const capacités: CapacitésNoeud = {
      webgpu: body.capacités?.webgpu === true,
      memoireGo: Number(body.capacités?.memoireGo) || undefined,
      adaptateur: body.capacités?.adaptateur,
      features: Array.isArray(body.capacités?.features) ? body.capacités?.features : undefined,
      appareil: body.capacités?.appareil,
    };

    // Le batteur central (sentinelle + ré-attribution) est garanti vivant.
    assurerBatteur({
      surveiller: () => orchestrateurEssaim.surveiller(),
      attribuer: () => orchestrateurEssaim.attribuer(),
    });

    const noeud = registreEssaim.battre(noeudId, guard.context.userId, capacités);

    // L'agent signale qu'il commence réellement l'exécution d'une part.
    if (body.fragmentId) {
      orchestrateurEssaim.démarrerFragment(body.fragmentId, noeudId);
    }

    // Sentinelle + distribution : les fragments en attente trouvent preneur.
    orchestrateurEssaim.surveiller();
    const confiés = orchestrateurEssaim.attribuer();

    // Diffusion SSE vers les détenteurs (onde ciblée).
    for (const f of confiés) {
      if (!f.noeudId) continue;
      ondePorteuse.publier(
        f.génération > 0
          ? { type: "relance", noeudId: f.noeudId, fragment: f, noeudPerdu: "sentinelle" }
          : { type: "affectation", noeudId: f.noeudId, fragments: [f] },
      );
    }

    const miennes = confiés.filter((f) => f.noeudId === noeudId);
    const état = registreEssaim.état();
    return NextResponse.json({
      success: true,
      noeud: {
        score: noeud.score,
        charge: noeud.charge,
        succès: noeud.succès,
      },
      affectations: miennes as FragmentTravail[],
      essaim: { noeudsEnLigne: état.noeudsEnLigne },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `Battement d'onde rejeté : ${error instanceof Error ? error.message : "erreur"}`,
      },
      { status: 500 },
    );
  }
}

/** Déconnexion PROPRE : l'agent prévient avant de partir (fermeture d'onglet). */
export async function DELETE(request: NextRequest) {
  const guard = await résoudreIdentitéNœud(request);
  if (!guard.ok) return guard.response;
  try {
    const body = (await request.json()) as { noeudId?: string };
    const noeudId = String(body.noeudId ?? "");
    if (NOEUD_RE.test(noeudId) && registreEssaim.appartient(noeudId, guard.context.userId)) {
      registreEssaim.partir(noeudId);
      orchestrateurEssaim.surveiller();
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: true });
  }
}
