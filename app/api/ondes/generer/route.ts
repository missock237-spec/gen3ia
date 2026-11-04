import { NextResponse } from "next/server";
import { z } from "zod";

import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { withAuth } from "@/lib/server/with-auth";
import {
  BORNES_GENERATION,
  genererDepuisIntention,
} from "@/lib/ondes/generateur-multimodal";

/**
 * GÉNÉRATION MULTIMODALE PAR ONDES — Phase 4 de l'intégration au cœur
 * de l'architecture W-DNN : l'API accepte une intention textuelle et
 * renvoie le FLUX D'ONDES (tenseur d'onde commun quantifié, ~4 octets
 * par état) + les INSTRUCTIONS DE RENDU LOCAL (shader WGSL, uniformes).
 * Le rendu lourd se déroule sur le GPU de l'utilisateur en zéro-copie
 * (shaders-manifold.ts) — le serveur exécute le miroir CPU comme preuve
 * de reproductibilité (empreinte de cohérence) et ne transporte jamais
 * de pixels ni d'audio dans la réponse.
 *
 * Honnêteté : champ `moteur: "cpu"` (miroir serveur), latence MESURÉE,
 * watts ESTIMÉS (méthode étiquetée `estimation-calibree`).
 *
 * Garde canonique des nouvelles routes : withAuth (défense en profondeur
 * au-delà du middleware) + limite de débit par IP (le miroir CPU est un
 * calcul réel) + schéma zod borné.
 */

export const dynamic = "force-dynamic";

const SchemaGeneration = z.object({
  intention: z
    .string()
    .min(1, "Intention requise : rien à mettre en résonance.")
    .max(
      BORNES_GENERATION.intentionMax,
      `Intention trop longue (${BORNES_GENERATION.intentionMax} caractères maximum).`,
    ),
  modalite: z.enum(["image", "audio", "video"]),
  nbNoeuds: z
    .number()
    .int()
    .min(16, "Au moins 16 nœuds.")
    .max(
      BORNES_GENERATION.nbNoeudsMax,
      `Au plus ${BORNES_GENERATION.nbNoeudsMax} nœuds.`,
    )
    .optional()
    .default(BORNES_GENERATION.nbNoeudsDefaut),
  largeur: z.number().int().min(16).max(BORNES_GENERATION.dimensionMax).optional(),
  hauteur: z.number().int().min(16).max(BORNES_GENERATION.dimensionMax).optional(),
  nbEchantillons: z
    .number()
    .int()
    .min(256)
    .max(BORNES_GENERATION.nbEchantillonsMax)
    .optional(),
});

export const POST = withAuth(async (requete: Request) => {
  // Limite de débit par IP : le miroir CPU de vérification est un calcul
  // réel (synthèse jusqu'à 44 100 échantillons × nœuds actifs). 30
  // générations / 5 minutes.
  const limite = await enforceRateLimit(`ondes-generer:${clientIp(requete)}`, {
    limit: 30,
    windowMs: 5 * 60 * 1000,
  });
  if (!limite.allowed) {
    return NextResponse.json(
      { erreur: "Trop de générations d'ondes. Réessayez dans quelques minutes." },
      { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limite.retryAfterMs / 1000))) } },
    );
  }

  let corps: unknown;
  try {
    corps = await requete.json();
  } catch {
    return NextResponse.json({ erreur: "Corps JSON invalide." }, { status: 400 });
  }

  const parse = SchemaGeneration.safeParse(corps);
  if (!parse.success) {
    return NextResponse.json(
      { erreur: "Requête invalide.", details: parse.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const offre = genererDepuisIntention(parse.data);
    return NextResponse.json({ succes: true, offre });
  } catch (erreur) {
    return NextResponse.json(
      {
        erreur:
          erreur instanceof Error
            ? erreur.message
            : "Échec de la génération d'ondes.",
      },
      { status: 500 },
    );
  }
});
