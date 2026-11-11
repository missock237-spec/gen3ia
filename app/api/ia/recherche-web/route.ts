/* ------------------------------------------------------------------ */
/* API RECHERCHE WEB TEMPS RÉEL gen3ia — /api/ia/recherche-web         */
/* ------------------------------------------------------------------ */
/* Le point d'accès REST du moteur de recherche web temps réel demandé  */
/* par l'architecture propriétaire : les clients de gen3ia (chat,       */
/* workspace, sous-agents, UI) posent une requête et reçoivent des      */
/* résultats RÉELS : multi-moteurs (SearXNG/DuckDuckGo/Bing/Wikipédia), */
/* dédoublonnés (URL + contenu), vérifiés (dates, crédibilité), avec    */
/* les pages réellement lues (Playwright/Chromium ou HTTP) et un        */
/* diagnostic honnête des moteurs.                                      */
/* Authentification obligatoire (requireUser) + quota dé distribués.    */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { HttpError } from "@/lib/security/http-errors";
import { rechercheWebTempsReel, blocContexteSource } from "@/lib/recherche-web";

const DemandeRecherche = z.object({
  query: z.string().min(2).max(400),
  maxResults: z.number().int().min(1).max(20).default(8),
  /** Lire réellement le contenu des meilleures pages (défaut : true). */
  lirePages: z.boolean().default(true),
  /** Inclure le bloc de contexte sourcé prêt pour le chat (citations [n]). */
  inclureBloc: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);

    const quota = await rateLimitDistributed(`ia:recherche-web:${user.uid}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!quota.allowed) {
      throw new HttpError(
        429,
        "Trop de recherches : patientez un instant avant la prochaine.",
        "RATE_LIMITED",
      );
    }

    const corps = (await request.json().catch(() => null)) as unknown;
    const parse = DemandeRecherche.safeParse(corps);
    if (!parse.success) {
      throw new HttpError(400, "Requête de recherche invalide (query, maxResults, lirePages).", "INVALID_REQUEST");
    }

    const reponse = await rechercheWebTempsReel(parse.data.query, {
      maxResults: parse.data.maxResults,
      lirePages: parse.data.lirePages,
    });

    return NextResponse.json(
      {
        ...reponse,
        blocContexte: parse.data.inclureBloc ? blocContexteSource(reponse) : undefined,
        requestId,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (erreur) {
    const statut = errorStatus(erreur);
    return NextResponse.json(
      errorBody(erreur, requestId),
      { status: statut, headers: { "x-request-id": requestId } },
    );
  }
}

export async function GET(request: NextRequest) {
  // GET = diagnostic du moteur : moteurs actifs configurés (sans requête
  // réseau) — sert à l'UI de santé et aux vérifications de production.
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    await requireUser(request); // GET authentifié comme le POST (diagnostic réservé aux membres)
    const { moteursRechercheActifs } = await import("@/lib/recherche-web");
    const { forcerDisponibiliteNavigateur } = await import(
      "@/lib/recherche-web/extraction/navigation-playwright"
    );
    // Test de disponibilité Chromium court (le module met le résultat en cache).
    let chromium: "disponible" | "indisponible" = "indisponible";
    try {
      // Pas de réseau réel ici : on ne teste que la présence du navigateur.
      const mod = (await import("playwright-core")) as { chromium?: { launch(o?: unknown): Promise<{ close(): Promise<void> }> } };
      const nav = await mod.chromium?.launch({ headless: true });
      if (nav) {
        chromium = "disponible";
        forcerDisponibiliteNavigateur("disponible");
        await nav.close();
      }
    } catch {
      chromium = "indisponible";
      forcerDisponibiliteNavigateur("indisponible");
    }
    return NextResponse.json(
      { moteursActifs: moteursRechercheActifs(), chromium, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (erreur) {
    const statut = errorStatus(erreur);
    return NextResponse.json(
      errorBody(erreur, requestId),
      { status: statut, headers: { "x-request-id": requestId } },
    );
  }
}
