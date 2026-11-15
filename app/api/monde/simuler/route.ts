import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { protectRoute } from "@/lib/security/route-guard";
import { interpreter } from "@/lib/monde/intention";
import { repartiteurGlobal } from "@/lib/essaim-global/repartiteur";
import { simuler, type SpecSimulation } from "@/lib/monde/univers";

/**
 * Simulation du Monde via l'essaim global — l'unique point d'entrée
 * PROGRAMMATIQUE (l'interface /monde calcule elle-même dans le
 * navigateur : c'est l'architecture « utilisateurs infinis », chaque
 * client apporte son GPU). Cette route existe pour les intégrations
 * externes et démontre le répartiteur : admission par quota, files
 * bornées, refus propre 429 — le serveur ne peut jamais saturer.
 *
 * GARDE D'ACCÈS (défense en profondeur, appliquée AVANT tout calcul) :
 * le chemin /api/monde est classé « restreint » par la matrice
 * lib/security/user-access.ts — le middleware bloque déjà les
 * utilisateurs standard (403) mais LAISSE PASSER les requêtes anonymes
 * (contrat : la route lève le 401 elle-même). protectRoute ré-applique
 * la même matrice au niveau de la route :
 *   - anonyme          → 401 (requireUser : Bearer Firebase OU cookie
 *                        de session signé gen3ia_session) ;
 *   - utilisateur std  → 403 (hors liste blanche utilisateur) ;
 *   - admin            → passage, puis rate limit 10 req/min par
 *                        utilisateur (barrière de débit indépendante du
 *                        répartiteur d'admission de l'essaim).
 * Les intégrations externes s'authentifient par Bearer Firebase
 * (structurellement immunisé au CSRF) ; le navigateur /monde passe par
 * le cookie de session (fetch same-origin : cookies envoyés par défaut).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Taille max du corps : une question (≤ 2000 car.) + une spec JSON. */
const TAILLE_MAX_CORPS = 16 * 1024;

/** Caps serveur : plus stricts que le client (VPS 2 Go). */
const CAPS_SERVEUR = {
  resolutionMax: 96,
  pasMax: 12_000,
};

const SchemaQuestion = z.object({
  /** Question libre en français OU spécification structurée complète. */
  question: z.string().min(1).max(2000).optional(),
  /** Spécification typée (prioritaire si fournie). */
  spec: z.record(z.string(), z.unknown()).optional(),
  // NB : l'ancien champ `utilisateur` (identité de quota fournie par le
  // client) n'est plus accepté — l'identité de quota est désormais
  // dérivée de l'authentification (uid vérifié), impossible à usurper.
});

/** Applique les caps serveur à une spécification si elle en porte. */
function plafonner(spec: Record<string, unknown>): Record<string, unknown> {
  const copie = { ...spec };
  if (typeof copie.resolution === "number" && copie.resolution > CAPS_SERVEUR.resolutionMax) {
    copie.resolution = CAPS_SERVEUR.resolutionMax;
  }
  if (typeof copie.pas === "number" && copie.pas > CAPS_SERVEUR.pasMax) {
    copie.pas = CAPS_SERVEUR.pasMax;
  }
  return copie;
}

export async function POST(request: NextRequest) {
  const debut = performance.now();

  // ——— Garde d'accès AVANT tout calcul coûteux (401 / 403 / 429) ———
  const guard = await protectRoute(request, {
    key: "monde-simuler",
    rateLimit: { limit: 10, windowMs: 60 * 1000 },
  });
  if (!guard.ok) return guard.response;

  // ——— Corps : taille bornée AVANT parsing, puis schéma strict ———
  const brut = await request.text().catch(() => "");
  if (Buffer.byteLength(brut, "utf8") > TAILLE_MAX_CORPS) {
    return NextResponse.json(
      { erreur: "Corps trop volumineux (16 Ko maximum)." },
      { status: 413 },
    );
  }

  let corps: unknown;
  try {
    corps = JSON.parse(brut);
  } catch {
    return NextResponse.json({ erreur: "Corps JSON invalide." }, { status: 400 });
  }

  const analyse = SchemaQuestion.safeParse(corps);
  if (!analyse.success) {
    return NextResponse.json(
      { erreur: "Requête invalide.", details: analyse.error.flatten() },
      { status: 400 },
    );
  }

  const { question, spec } = analyse.data;

  // ——— Admission dans l'essaim global (quota + files bornées) ———
  // Identité de quota = uid AUTHENTIFIÉ (plus jamais une chaîne fournie
  // par le client, qui permettait d'épuiser le quota d'autrui).
  const repartiteur = repartiteurGlobal();
  const decision = repartiteur.soumettre(guard.context.userId);
  if (!decision.admis) {
    return NextResponse.json(
      {
        erreur:
          decision.raison === "quota"
            ? "Quota dépassé — ralentissez (le répartiteur protège la plateforme)."
            : "Serveur saturé — réessayez dans un instant ou calculez localement depuis /monde.",
        raison: decision.raison,
      },
      { status: 429, headers: { "retry-after": "2" } },
    );
  }

  try {
    // ——— Intention : français → spécification ———
    let specFinale: SpecSimulation | null = null;
    let comprehension = "";
    let suppositions: string[] = [];
    let confiance = 1;

    if (spec) {
      specFinale = plafonner(spec) as unknown as SpecSimulation;
      comprehension = "Spécification structurée acceptée telle quelle.";
    } else if (question) {
      const intention = interpreter(question);
      if (!intention) {
        repartiteur.terminer(decision.ticket);
        return NextResponse.json(
          {
            erreur:
              "Aucun domaine physique détecté dans la question. Exemples : « projectile à 50 m/s à 45° », « fentes de Young à 600 nm », « résous y' = -y », « dilatation du temps à 99 % de c ».",
          },
          { status: 422 },
        );
      }
      specFinale = intention.spec;
      comprehension = intention.comprehension;
      suppositions = intention.suppositions;
      confiance = intention.confiance;
    } else {
      repartiteur.terminer(decision.ticket);
      return NextResponse.json({ erreur: "Fournissez « question » ou « spec »." }, { status: 400 });
    }

    // ——— Exécution ———
    const resultat = simuler(specFinale);
    repartiteur.terminer(decision.ticket);

    return NextResponse.json({
      ok: true,
      comprehension,
      confiance,
      suppositions,
      resultat,
      essaim: {
        ticket: decision.ticket.id,
        attenteEstimeeMs: Math.round(decision.attenteEstimee),
        dureeTraitementMs: Math.round(performance.now() - debut),
      },
    });
  } catch (erreur) {
    repartiteur.terminer(decision.ticket);
    const message = erreur instanceof Error ? erreur.message : "Erreur de simulation.";
    return NextResponse.json({ erreur: message }, { status: 400 });
  }
}
