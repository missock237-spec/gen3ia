import { NextResponse } from "next/server";

import { composerDepuisVocation, statsPontVocation } from "@/lib/neural/vocation-pont";
import { enregistrerReponsePont, enregistrerRefusPont } from "@/lib/neural/compteur-pont-vocation";

/**
 * QUESTIONS DANS LE CADRE D'APPRENTISSAGE DE GEN3 (it.66 — demande
 * propriétaire : « fais en sorte qu'il soit capable de répondre à des
 * questions qui rentrent dans son cadre d'apprentissage »).
 *
 * ENDPOINT PUBLIC (aucune donnée utilisateur, aucune écriture) : une
 * question entre, la réponse composée DEPUIS LA CHARTE DE VOCATION sort —
 * domaine reconnu, tâches correspondantes, outils réels, score lexical.
 * Zéro invention : hors cadre apparent, la réponse dit « connu: false »
 * honnêtement (le pont ne fabrique jamais de domaine ni de capacité).
 *
 * Utilisée par le testeur de questions de la page publique /vocation —
 * le test demandé par le propriétaire (depuis le navigateur) est donc
 * reproductible par n'importe quel visiteur, sans compte.
 */
export const dynamic = "force-dynamic";

interface CorpsQuestion {
  question?: unknown;
}

export async function POST(request: Request) {
  let corps: CorpsQuestion;
  try {
    corps = (await request.json()) as CorpsQuestion;
  } catch {
    return NextResponse.json({ erreur: "Corps JSON invalide." }, { status: 400 });
  }

  const question = typeof corps.question === "string" ? corps.question.trim() : "";
  if (!question) {
    return NextResponse.json({ erreur: "Champ « question » (chaîne) requis." }, { status: 400 });
  }
  if (question.length > 600) {
    return NextResponse.json({ erreur: "Question trop longue (600 caractères maximum)." }, { status: 400 });
  }

  const composition = composerDepuisVocation(question);
  if (!composition) {
    // HONNÊTÉ : la question ne tombe pas (encore) dans le cadre reconnu —
    // aucune réponse fabriquée. Le champ motif dit quoi faire ensuite.
    // it.75 — le refus honnête est compté (somme d'entiers mesurée) et
    // exposé par /api/energie → pontVocation.
    enregistrerRefusPont();
    return NextResponse.json({
      connu: false,
      reponse: null,
      motif:
        "Question hors du cadre reconnu pour l'instant : reformulez avec les mots d'un des 19 domaines de vocation (recherche web, contrôle de données, rédaction, code, cybersécurité…).",
      stats: statsPontVocation(),
    });
  }

  // it.75 — la réponse du pont est comptée (somme d'entiers mesurée) :
  // servie SANS fenêtre moteur, par construction de cet endpoint (tout
  // profil) — exposée par /api/energie → pontVocation.
  enregistrerReponsePont();
  return NextResponse.json({
    connu: true,
    reponse: composition.texte,
    theme: composition.theme ?? null,
    score: composition.scoreAppariement ?? null,
    source: composition.source,
    stats: statsPontVocation(),
  });
}

/** GET : contrat de l'endpoint (auto-documentation, zéro état secret). */
export async function GET() {
  const exempleConnue = composerDepuisVocation("que sais-tu faire en cybersécurité ?");
  return NextResponse.json({
    endpoint: "POST /api/neural/questions",
    contrat: {
      question: "chaîne (1–600 caractères) — la question posée à gen3",
    },
    reponseConnue: {
      connu: true,
      reponse: "<texte ancré dans la charte de vocation>",
      theme: "vocation:<domaine-id>",
      score: "<score d'appariement 0..1>",
      source: "vocation",
    },
    reponseInconnue: {
      connu: false,
      reponse: null,
      motif: "<motif de reformulation honnête>",
    },
    exemple: exempleConnue
      ? { question: "que sais-tu faire en cybersécurité ?", connu: true, theme: exempleConnue.theme ?? null }
      : null,
    stats: statsPontVocation(),
  });
}
