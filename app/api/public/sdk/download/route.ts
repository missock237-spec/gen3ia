import { NextResponse, type NextRequest } from "next/server";

import { SDK_TARBALL_PUBLIC_PATH } from "@/lib/public-sdk/manifest";

/**
 * Distribution du tarball du SDK (Task 61).
 *
 * GET /api/public/sdk/download — redirection 302 vers l'asset statique
 * public/sdk/<fichier versionné>.npm npm/pnpm/yarn suivent les redirections
 * : `npm install https://gen3ia.online/api/public/sdk/download` installe le
 * SDK sans registre public.
 *
 * POURQUOI UNE REDIRECTION plutôt qu'un streaming depuis le système de
 * fichiers : les fichiers de public/ sont servis par le CDN Vercel en
 * statique — ils ne sont PAS garantis présents dans le système de fichiers
 * de la fonction serverless, un fs.readFile serait fragile. Le nom de
 * fichier EMBEDS la version : l'asset est immuable, la redirection peut
 * donc être no-store (toujours fraîche) sans coût réel.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL(SDK_TARBALL_PUBLIC_PATH, request.url), {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
}
