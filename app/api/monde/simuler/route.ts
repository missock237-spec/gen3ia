import { NextResponse } from "next/server";
import { z } from "zod";

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
 */

export const dynamic = "force-dynamic";

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
  /** Identifiant utilisateur (quota) — anonyme acceptable. */
  utilisateur: z.string().min(1).max(64).optional(),
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

export async function POST(request: Request) {
  const debut = performance.now();

  let corps: unknown;
  try {
    corps = await request.json();
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

  const { question, spec, utilisateur } = analyse.data;

  // ——— Admission dans l'essaim global (quota + files bornées) ———
  const repartiteur = repartiteurGlobal();
  const decision = repartiteur.soumettre(utilisateur ?? request.headers.get("x-forwarded-for") ?? "anonyme");
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
