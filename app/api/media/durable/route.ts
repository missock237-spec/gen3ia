import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { createPermanentDownloadUrl } from "@/lib/storage/permanent-user-storage";
import { createVideoPlaybackUrl } from "@/lib/video/storage";
import { estCleMediaProprietaire } from "@/lib/media/url-durable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RÉSOLUTION DURABLE DES MÉDIAS PERSISTÉS (voir lib/media/url-durable.ts).
 *
 * GET /api/media/durable?path=… → 302 vers une URL signée FRAÎCHE du
 * fichier du propriétaire. Deux familles de clés, chacune re-validée par
 * sa fonction de signature (double barrière anti-traversée) :
 *  - `users/<uid>/permanent/…` → createPermanentDownloadUrl (600 s) ;
 *  - `users/<uid>/video/…`     → createVideoPlaybackUrl (600 s) — les
 *    masters/exports du pipeline vidéo vivent sous ce préfixe.
 *
 * POURQUOI : les messages de conversation persistés (voix, vidéo) portent
 * désormais CETTE URL au lieu d'une présignée expirable — un message relu
 * des semaines plus tard reste jouable. Le lien d'un utilisateur NE PEUT
 * résoudre QUE ses propres clés : préfixe vérifié ici (UID de session)
 * puis re-validé par la fonction de signature (isOwnedPermanentKey /
 * isOwnedVideoKey).
 *
 * 302 (et pas un flux de bytes) : le navigateur suit la redirection pour
 * <audio src>, <video src> et un clic de téléchargement, R2 renvoie le
 * bon Content-Type, et l'app ne proxy-passe aucun octet (zéro coût).
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;
  const path = request.nextUrl.searchParams.get("path");
  if (!estCleMediaProprietaire(path, guard.context.userId)) {
    return NextResponse.json(
      { error: "Chemin de stockage média invalide ou hors stockage propriétaire." },
      { status: 400 },
    );
  }
  try {
    const cle = path as string;
    const url = cle.includes("/permanent/")
      ? await createPermanentDownloadUrl(guard.context.userId, cle)
      : await createVideoPlaybackUrl(guard.context.userId, cle, 600);
    return NextResponse.redirect(url, 302);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Résolution du média impossible." },
      { status: errorStatus(error, 400) },
    );
  }
}
