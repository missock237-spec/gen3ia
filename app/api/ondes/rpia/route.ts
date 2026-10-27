import { NextResponse } from "next/server";
import { z } from "zod";

import { CoucheOndesNeuronales } from "@/lib/neural/core/couche-rpia";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { withAuth } from "@/lib/server/with-auth";

/**
 * Entraînement RPIA côté serveur — met une requête utilisateur en
 * résonance (couche d'ondes neuronales, 1 nœud par neurone du cerveau)
 * et retourne le rapport d'apprentissage HONNÊTE : courbe d'erreur,
 * convergence réelle, énergies de résonance produites pour le cerveau.
 *
 * Le serveur n'a pas de GPU utilisateur : le miroir CPU déterministe
 * exécute exactement la physique du shader WebGPU (même contrat que la
 * fabrique du champ d'ondes). Aucune donnée persistée : la route est
 * bornée (nœuds, époques, longueur de texte), sans état.
 *
 * P0 (durcissement calcul) : l'entraînement RPIA est un calcul CPU réel
 * (jusqu'à 4096 nœuds × 500 époques) — il est maintenant soumis à une
 * limite de débit par IP en plus de la garde d'auth obligatoire du
 * middleware (mutation non publique ⇒ identité vérifiée exigée en amont).
 * La route applique en outre SA PROPRE garde withAuth (défense en
 * profondeur : elle ne dépend pas du middleware seul) et reçoit l'identité
 * vérifiée en troisième argument — pattern canonique des nouvelles routes.
 */

export const dynamic = "force-dynamic";

const SchemaRPIA = z.object({
  texte: z
    .string()
    .min(1, "Texte requis : rien à mettre en résonance.")
    .max(2000, "Texte trop long (2000 caractères maximum)."),
  nbNoeuds: z
    .number()
    .int()
    .min(16, "Au moins 16 nœuds.")
    .max(4096, "Au plus 4096 nœuds.")
    .optional()
    .default(100),
  epoques: z
    .number()
    .int()
    .min(1, "Au moins 1 époque.")
    .max(500, "Au plus 500 époques.")
    .optional()
    .default(120),
  tauxApprentissage: z
    .number()
    .min(0.0001)
    .max(0.1)
    .optional()
    .default(0.01),
});

/** Historique d'erreur renvoyé plafonné (réponse légère). */
const MAX_POINTS_HISTORIQUE = 120;

export const POST = withAuth(async (requete: Request) => {
  // Limite de débit par IP : borne le coût CPU par client (calcul réel,
  // même sans données persistées). 20 entraînements / 5 minutes.
  const limite = await enforceRateLimit(`ondes-rpia:${clientIp(requete)}`, {
    limit: 20,
    windowMs: 5 * 60 * 1000,
  });
  if (!limite.allowed) {
    return NextResponse.json(
      { erreur: "Trop d'entraînements RPIA. Réessayez dans quelques minutes." },
      { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limite.retryAfterMs / 1000))) } },
    );
  }

  let corps: unknown;
  try {
    corps = await requete.json();
  } catch {
    return NextResponse.json({ erreur: "Corps JSON invalide." }, { status: 400 });
  }

  const parse = SchemaRPIA.safeParse(corps);
  if (!parse.success) {
    return NextResponse.json(
      { erreur: "Requête invalide.", details: parse.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { texte, nbNoeuds, epoques, tauxApprentissage } = parse.data;

  try {
    const couche = new CoucheOndesNeuronales(nbNoeuds);
    const rapport = couche.entrainerVersTexte(texte, epoques, {
      tauxApprentissage,
      pasDeTemps: 0.1,
    });

    const energies = couche.energiesResonance();
    const echantillonEnergies = Object.fromEntries(
      Object.entries(energies).slice(0, 100),
    );

    return NextResponse.json({
      succes: true,
      moteur: "cpu", // honnêteté : le serveur exécute le miroir CPU du shader
      nbNoeuds,
      epoques,
      tauxApprentissage,
      rapport: {
        ...rapport,
        historiqueErreur:
          rapport.historiqueErreur.length > MAX_POINTS_HISTORIQUE
            ? rapport.historiqueErreur.slice(0, MAX_POINTS_HISTORIQUE)
            : rapport.historiqueErreur,
      },
      energiesResonance: echantillonEnergies,
    });
  } catch (erreur) {
    return NextResponse.json(
      {
        erreur:
          erreur instanceof Error
            ? erreur.message
            : "Échec de l'entraînement RPIA.",
      },
      { status: 500 },
    );
  }
});
