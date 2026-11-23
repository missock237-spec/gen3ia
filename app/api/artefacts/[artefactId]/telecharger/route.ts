import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getArtifact } from "@/lib/domain/artifacts/repository";
import { downloadFromR2 } from "@/lib/storage/r2";
import { snifferContentTypeMedia } from "@/lib/media/analyze";

/**
 * TÉLÉCHARGEMENT DES ARTEFACTS — chaque utilisateur télécharge ce que gen3
 * a créé pour lui (image, audio, vidéo, fichier, document). Propriété
 * stricte (`getArtifact` refuse les artefacts d'autrui), téléchargement
 * FORCÉ (`content-disposition: attachment` — le navigateur propose
 * d'enregistrer au lieu d'afficher). Les vidéos de production en cours
 * (sans fichier final) sont redirigées honnêtement vers le studio vidéo.
 */
const TAILLE_MAX = 100 * 1024 * 1024; // même plafond que downloadFromR2

function nomFichier(titre: string, defaut: string): string {
  const propre = titre
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, "-");
  return propre ? `${propre}-${defaut}` : defaut;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ artefactId: string }> }) {
  try {
    const user = await requireUser(request);
    const { artefactId } = await params;
    // `?apercu=1` : affichage INLINE (l'UI met à jour l'image éditée) au lieu du forçage téléchargement.
    const apercuInline = request.nextUrl.searchParams.get("apercu") === "1";
    const artefact = await getArtifact(user.uid, artefactId);
    if (!artefact) {
      return NextResponse.json(
        errorBody(new Error("Artefact introuvable pour ce compte (propriété stricte)."), "Artefact introuvable."),
        { status: 404 },
      );
    }
    // Vidéo de production en cours : pas de fichier final à télécharger.
    if (artefact.type === "video" && !artefact.storagePath && !artefact.content && artefact.videoProjectId) {
      return NextResponse.json({
        ok: false,
        message:
          "Cette vidéo référence une production en cours : le rendu final se télécharge depuis le studio vidéo (/studio/video/" +
          artefact.videoProjectId +
          ") dès qu'il est terminé.",
      });
    }

    if (artefact.storagePath) {
      const buffer = await downloadFromR2(artefact.storagePath, TAILLE_MAX);
      const mime = snifferContentTypeMedia(buffer, artefact.type === "image" ? "image/png" : artefact.type === "audio" ? "audio/wav" : "application/octet-stream");
      const extension = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
      const nom = nomFichier(artefact.title || artefact.filename || "artefact", `gen3.${extension}`);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "content-type": mime,
          "content-length": String(buffer.length),
          "content-disposition": `${apercuInline ? "inline" : "attachment"}; filename="${encodeURIComponent(nom)}"`,
          "cache-control": "private, no-store",
        },
      });
    }

    if (artefact.content) {
      // Artefact textuel (code, document, rapport) : téléchargé tel quel.
      const nom = nomFichier(artefact.title || "artefact", "gen3.txt");
      return new NextResponse(artefact.content, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${encodeURIComponent(nom)}"`,
          "cache-control": "private, no-store",
        },
      });
    }

    return NextResponse.json(
      errorBody(new Error("Aucun contenu téléchargeable sur cet artefact."), "Aucun contenu téléchargeable."),
      { status: 404 },
    );
  } catch (erreur) {
    const statut = errorStatus(erreur, 500);
    return NextResponse.json(errorBody(erreur, "Le téléchargement a échoué."), { status: statut });
  }
}
