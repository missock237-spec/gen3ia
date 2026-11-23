import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { editerArtefact, editerMediaParUrl } from "@/lib/artefacts/edition";

/**
 * BOUTON « MODIFIER » DES ARTEFACTS — le prompt de l'utilisateur transforme
 * RÉELLEMENT son image / audio / vidéo (moteur : lib/artefacts/edition).
 * `artefactId` → nouvelle VERSION de l'artefact existant ; `url`+`type` →
 * éditer un média du fil et créer un NOUVEL artefact propriété du compte.
 */
const corpsSchema = z.object({
  artefactId: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2048).optional(),
  type: z.enum(["image", "audio", "video"]).optional(),
  prompt: z.string().min(2).max(1000),
  titre: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const corps = corpsSchema.parse(await request.json());
    if (corps.artefactId) {
      const rapport = await editerArtefact({
        userId: user.uid,
        artefactId: corps.artefactId,
        prompt: corps.prompt,
      });
      return NextResponse.json({
        ok: true,
        artefactId: rapport.artefactId,
        version: rapport.version,
        type: rapport.type,
        operations: rapport.operations,
        nonComprises: rapport.nonComprises,
        storagePath: rapport.storagePath,
        details: rapport.note,
      });
    }
    if (!corps.url) {
      return NextResponse.json(
        errorBody(new Error("Fournir `artefactId` ou `url` pour l'édition."), "Requête d'édition incomplète."),
        { status: 400 },
      );
    }
    const rapport = await editerMediaParUrl({
      userId: user.uid,
      type: corps.type ?? "image",
      url: corps.url,
      prompt: corps.prompt,
      titre: corps.titre,
    });
    return NextResponse.json({
      ok: true,
      artefactId: rapport.artefactCree,
      version: rapport.version,
      type: rapport.type,
      operations: rapport.operations,
      nonComprises: rapport.nonComprises,
      storagePath: rapport.storagePath,
      details: rapport.note,
    });
  } catch (erreur) {
    const statut = errorStatus(erreur, 400);
    return NextResponse.json(errorBody(erreur, "L'édition n'a pas pu être appliquée."), { status: statut });
  }
}
