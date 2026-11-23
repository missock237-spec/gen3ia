import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  delivrerDepuisFacturation,
  listerClesEntrainement,
  NIVEAUX_ENTRAINEMENT,
} from "@/lib/training/cles-entrainement";

/**
 * CLÉS DE NIVEAU UNIQUE D'ENTRAÎNEMENT — voie d'obtention OFFICIELLE depuis
 * la facturation. POST {niveau} : délivre la clé SI l'abonnement courant
 * couvre le niveau (grille plans.ts ; la vérification fait foi). GET : liste
 * les clés du compte (jamais de secret — seuls aperçu/hash et statut).
 */
const demandeSchema = z.object({ niveau: z.enum(NIVEAUX_ENTRAINEMENT) });

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const corps = demandeSchema.parse(await request.json());
    const resultat = await delivrerDepuisFacturation({ userId: user.uid, niveau: corps.niveau });
    return NextResponse.json({
      ok: true,
      cle: resultat.cle,
      keyId: resultat.keyId,
      apercu: resultat.apercu,
      niveau: resultat.niveau,
      avis: "Conserver la clé maintenant : elle n'est plus affichée (stockée par son SHA-256 uniquement).",
    });
  } catch (erreur) {
    const statut = errorStatus(erreur);
    return NextResponse.json(errorBody(erreur), { status: statut });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const cles = await listerClesEntrainement(user.uid);
    return NextResponse.json({
      ok: true,
      cles: cles.map((c) => ({
        keyId: c.keyId,
        apercu: c.apercu,
        niveau: c.niveau,
        revoquee: c.revoquee,
        delivreeLe: c.delivreeLe,
        source: c.source,
      })),
    });
  } catch (erreur) {
    const statut = errorStatus(erreur);
    return NextResponse.json(errorBody(erreur), { status: statut });
  }
}
