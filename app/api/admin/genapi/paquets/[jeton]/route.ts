import { NextResponse, type NextRequest } from "next/server";

import { consommerJetonPaquet } from "@/lib/genapi/provisionnement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nom de fichier du paquet : gzip custom (format interne genAPI). */
const NOM_FICHIER_PAQUET = "gen3-client-package.bin.gz";

/**
 * GET /api/admin/genapi/paquets/[jeton] — téléchargement du package client
 * genAPI à USAGE UNIQUE.
 *
 * Pas de garde session ici : le jeton (aléatoire, à usage unique, expirant)
 * EST la garde du lien autoportant — même design que les liens à token du
 * dépôt (triggers webhook, approvals messaging). La console admin copie ce
 * lien pour le transmettre à la machine cliente du provisionné.
 *
 * consommerJetonPaquet brûle le jeton ATOMIQUEMENT : consommé, inconnu ou
 * expiré → 410 Gone (le lien est mort pour tout le monde, réutilisable par
 * personne). Le contenu du paquet (clé privée) n'est JAMAIS journalisé.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jeton: string }> },
) {
  const { jeton } = await context.params;

  let resultat: Awaited<ReturnType<typeof consommerJetonPaquet>>;
  try {
    resultat = await consommerJetonPaquet(jeton);
  } catch {
    // Panne technique du socle (Firestore, daemon) : 500 propre — le jeton
    // reste consommable (la consommation atomique n'a pas abouti).
    return NextResponse.json(
      { error: "genAPI indisponible : téléchargement impossible pour le moment." },
      { status: 500 },
    );
  }

  if (!resultat.ok || !resultat.paquet) {
    return NextResponse.json(
      { error: "Lien de téléchargement déjà utilisé ou expiré." },
      { status: 410 },
    );
  }

  // Corps binaire propre : copie en Uint8Array (BodyInit stable, aucune
  // référence au buffer interne du socle). Aucun log du contenu.
  const corps = new Uint8Array(resultat.paquet);
  return new Response(corps, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${NOM_FICHIER_PAQUET}"`,
      "cache-control": "no-store",
    },
  });
}
