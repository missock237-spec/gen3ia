import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";
import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * API DES COMPARTIMENTS CALCULABLES (it.114 — demande propriétaire :
 * math, sciences/monde virtuel, code/terminal virtuel, raisonnement —
 * branchés au cerveau, accessibles « via le chat IA et/ou via l'API »).
 *
 * GET  /api/compartiments — état honnête des quatre compartiments :
 *      statistiques du raisonnement (traces), du terminal, du monde,
 *      de la passerelle, et comptabilité 1 Go de la mémoire de domaines.
 *
 * POST /api/compartiments — soumettre une requête À L'ORCHESTRATEUR DE
 *      RAISONNEMENT du cerveau : analyse → rappel → candidats → évaluation →
 *      choix argumenté. La réponse porte la réponse servie (ou null, honnête)
 *      ET la trace de raisonnement complète — gen3 montre comment il pense.
 *
 * GARDE : utilisateur requis (session signée ou Bearer Firebase) + rate
 * limit par utilisateur. Le compartiment terminal n'exécute QUE dans son
 * sandbox (aucun accès hôte) — le même garde que le chat.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SchemaRequete = z.object({
  question: z.string().min(1).max(2_000),
});

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const limite = await enforceRateLimit("compartiments-get", { limit: 60, windowMs: 60_000 });
    if (!limite.allowed) {
      return NextResponse.json({ error: "Trop de consultations." }, { status: 429 });
    }

    const { compartiments } = getNeuralRuntime();
    const m = compartiments.memoireDomaines.statistiques();
    return NextResponse.json({
      compartiments: {
        math: {
          familles: ["expression", "pourcentage", "moyenne", "conversion", "aire", "perimetre", "pythagore", "partage", "vitesse"],
          evaluation: "aucune dépendance eval/Function — évaluateur récursif propre",
        },
        sciences: {
          familles: compartiments.monde.capacites(),
          passerelle: compartiments.passerelle.statistiques(),
        },
        code: {
          commandes: ["aide", "calc", "js", "monde", "memoire", "sources", "etat", "historique", "historique-vider"],
          terminal: compartiments.terminal.statistiques(),
          sandbox: "vm contexte neuf — sans process/require/réseau/disque, timeout 1 s, sortie bornée",
        },
        raisonnement: {
          ...compartiments.orchestrateur.statistiques(),
          dernierRaisonnement: compartiments.orchestrateur.dernierRaisonnement() ?? null,
        },
      },
      memoireDomaines: {
        compartiments: m.compartiments,
        compartimentsCalculables: m.compartimentsCalculables,
        octetsReels: m.octetsReels,
        octetsInges: m.octetsInges,
        enseignements: m.enseignements,
        dateMesure: m.dateMesure,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limite = await enforceRateLimit(`compartiments-post:${user.uid}`, { limit: 20, windowMs: 60_000 });
    if (!limite.allowed) {
      return NextResponse.json(
        { error: "Trop de requêtes rapprochées. Réessayez dans quelques instants." },
        { status: 429, headers: { "retry-after": String(Math.ceil((limite.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }

    const corps = SchemaRequete.safeParse(await request.json());
    if (!corps.success) {
      return NextResponse.json(
        { error: "Corps invalide : { question: string }.", issues: corps.error.flatten() },
        { status: 400 },
      );
    }

    const { compartiments } = getNeuralRuntime();
    const resultat = compartiments.orchestrateur.resoudre(corps.data.question);
    return NextResponse.json({
      // Honnêteté : reponse = null quand l'intention est « connaissance » —
      // la conversation passe alors par le chat (corpus + mémoires), qui
      // reste le chemin canonique pour le savoir appris.
      reponse: resultat?.texte ?? null,
      source: resultat?.source ?? null,
      raisonnement: resultat?.trace ?? compartiments.orchestrateur.dernierRaisonnement(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}
