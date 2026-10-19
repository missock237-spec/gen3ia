import { NextResponse } from "next/server";
import { z } from "zod";

import { registreSignalisation } from "@/lib/ondes/registre-signalisation";

/**
 * Signalisation P2P de l'essaim d'ondes — le rôle EXACT du serveur dans
 * l'architecture W-DNN : relayer de courtes enveloppes (annonces,
 * offres/réponses/ICE WebRTC) le temps que deux navigateurs établissent
 * leur connexion directe. Aucun calcul d'IA, aucune donnée persistée :
 * la route est publique, en mémoire volatile, et bornée (salles, pairs,
 * files) côté registre.
 */

export const dynamic = "force-dynamic";

const SchemaMessage = z.object({
  salle: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "La salle ne contient que lettres, chiffres, tirets."),
  de: z.string().min(1).max(64),
  type: z.string().min(1).max(32),
  vers: z.string().max(64).optional(),
  charge: z.unknown().optional(),
  mid: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  let corps: unknown;
  try {
    corps = await request.json();
  } catch {
    return NextResponse.json({ erreur: "Corps JSON invalide." }, { status: 400 });
  }

  const analyse = SchemaMessage.safeParse(corps);
  if (!analyse.success) {
    return NextResponse.json(
      { erreur: "Enveloppe de signalisation invalide.", details: analyse.error.flatten() },
      { status: 400 },
    );
  }

  const registre = registreSignalisation();
  const { salle, de, type, vers, charge, mid } = analyse.data;

  // Toute publication est aussi un signe de vie.
  const admis = registre.rejoindre(salle, de);
  if (!admis) {
    return NextResponse.json({ erreur: "Salle saturée." }, { status: 429 });
  }

  const livraisons = registre.publier(salle, {
    de,
    type,
    vers,
    charge,
    mid: mid ?? `${de}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  });

  return NextResponse.json({ ok: true, livraisons, pairs: registre.nbPairs(salle) });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const salle = url.searchParams.get("salle");
  const pair = url.searchParams.get("pair");
  const verifie = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .safeParse(salle);
  const verifiePair = z.string().min(1).max(64).safeParse(pair);
  if (!verifie.success || !verifiePair.success) {
    return NextResponse.json({ erreur: "Paramètres de salle/pair invalides." }, { status: 400 });
  }

  const registre = registreSignalisation();
  // Un pair qui draine sans s'être annoncé s'auto-déclare (polling direct).
  registre.rejoindre(verifie.data, verifiePair.data);
  registre.toucher(verifie.data, verifiePair.data);
  registre.purger();

  const messages = registre.drainer(verifie.data, verifiePair.data);
  return NextResponse.json({
    messages,
    pairs: registre.nbPairs(verifie.data),
    salles: registre.nbSalles,
  });
}
