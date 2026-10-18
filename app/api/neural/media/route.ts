import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

import {
  genererVisuelNeuralEtPersister,
  genererAudioNeuralEtPersister,
  genererVideoNeuralEtPersister,
} from "@/lib/neural/media-service";

/**
 * MÉDIA NEURONAL — génération LOCALE par le moteur Gen3 (corps sémantique).
 *
 * Trois effecteurs, trois moteurs 100 % locaux (aucune IA externe —
 * supprimées du projet sur demande de l'utilisateur) :
 *  - visuel : composition SVG calculée depuis les synapses réelles du
 *    cerveau, rastérisée en PNG et archivée en R2 permanent ;
 *  - audio : signal WAV synthétisé depuis l'histogramme des poids appris ;
 *  - video : animation vectorielle SVG SMIL (les navigateurs l'animent).
 *
 * Chaque génération est DÉTERMINISTE (prompt + état neuronal courant) :
 * un cerveau plus entraîné produit une œuvre différente.
 */
export const dynamic = "force-dynamic";

const MediaBodySchema = z.object({
  type: z.enum(["visuel", "audio", "video"]),
  prompt: z.string().trim().min(1).max(2000),
  ratio: z.enum(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]).optional(),
  dureeSecondes: z.number().int().min(1).max(30).optional(),
  frequenceEchantillonnage: z.number().int().min(8000).max(48000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);

    // Garde anti-abus : la génération locale est gratuite (moteur interne),
    // le quota protège simplement la bande passante R2.
    const limit = await enforceRateLimit(`neural-media:${user.uid}`, {
      limit: 30,
      windowMs: 5 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de générations rapprochées. Réessayez dans quelques instants." },
        { status: 429, headers: { "retry-after": String(Math.ceil((limit.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }

    const body = MediaBodySchema.parse(await request.json());

    switch (body.type) {
      case "visuel": {
        const visuel = await genererVisuelNeuralEtPersister({
          userId: user.uid,
          prompt: body.prompt,
          ratio: body.ratio,
        });
        return NextResponse.json({ media: visuel });
      }
      case "audio": {
        const audio = await genererAudioNeuralEtPersister({
          userId: user.uid,
          prompt: body.prompt,
          dureeSecondes: body.dureeSecondes,
          frequenceEchantillonnage: body.frequenceEchantillonnage,
        });
        return NextResponse.json({ media: audio });
      }
      case "video": {
        const video = await genererVideoNeuralEtPersister({
          userId: user.uid,
          prompt: body.prompt,
          dureeSecondes: body.dureeSecondes,
        });
        return NextResponse.json({ media: video });
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Génération impossible." },
      { status: errorStatus(error, 400) },
    );
  }
}
