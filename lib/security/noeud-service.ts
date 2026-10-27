import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { clientIp, rateLimit } from "@/lib/security/rate-limit";
import {
  protectRoute,
  type RouteContext,
} from "@/lib/security/route-guard";

/* ------------------------------------------------------------------ */
/* IDENTITÉ DES NŒUDS MACHINE DE L'ESSAIM (Colab / worker GPU distant) */
/*                                                                    */
/* L'essaim média gen3 est composé de navigateurs (agents WebGPU).     */
/* L'activation de Colab ajoute des NŒUDS MACHINE : un notebook Colab  */
/* bat l'onde exactement comme un navigateur (POST /api/essaim/ondes)  */
/* et exécute ses parts sur le GPU du Colab (CUDA/torch).              */
/*                                                                    */
/* UNE SEULE GARDE par route (principe P0) : `résoudreIdentitéNœud`    */
/* accepte DEUX formes de credential dans la MÊME garde —              */
/*  1. Bearer <ESSAIM_NOEUD_TOKEN> (machine → identité de service      */
/*     fixe « system-noeud-essaim », comparaison timing-safe) ;        */
/*  2. tout autre Bearer → protectRoute (identité Firebase complète).  */
/* Sans ESSAIM_NOEUD_TOKEN configuré, la voie machine est DÉSACTIVÉE   */
/* (fail-closed) : les navigateurs continuent de fonctionner sans      */
/* changement, aucun nœud machine ne peut s'annoncer.                  */
/* ------------------------------------------------------------------ */

/** Identité de service unique portée par tous les nœuds machine. */
export const UTILISATEUR_NOEUD_SERVICE = "system-noeud-essaim";

/** Nombre max de battements/retours machine par IP et fenêtre de 5 min. */
const LIMITE_SERVICE = { limit: 600, windowMs: 5 * 60 * 1000 } as const;

function jetonConfiguré(): string {
  const valeur = (process.env.ESSAIM_NOEUD_TOKEN ?? "").trim();
  // Jeton trop court = un placeholder : on refuse (fail-closed).
  return valeur.length >= 24 ? valeur : "";
}

/** Comparaison timing-safe (longueurs alignées avant comparaison). */
export function jetonServiceValide(candidat: string): boolean {
  const attendu = jetonConfiguré();
  if (!attendu) return false;
  const a = Buffer.from(candidat);
  const b = Buffer.from(attendu);
  if (a.length !== b.length) {
    // Fuite de timing minimale sur la longueur : on compare quand même
    // contre une copie pour garder une empreinte constante.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

type Résolution =
  | { ok: true; context: RouteContext }
  | { ok: false; response: NextResponse };

/**
 * Résout l'identité d'un appel essaim : nœud machine (jeton de service)
 * OU utilisateur navigateur (Firebase). UNE garde, deux credentials.
 */
export async function résoudreIdentitéNœud(request: NextRequest): Promise<Résolution> {
  const entête = request.headers.get("authorization") ?? "";
  const candidat = entête.startsWith("Bearer ") ? entête.slice(7).trim() : "";
  if (candidat && jetonServiceValide(candidat)) {
    // Limite de débit IP pour la voie machine (une garde, même rigueur
    // que protectRoute côté utilisateur).
    const limite = rateLimit(`essaim-noeud:${clientIp(request)}`, LIMITE_SERVICE);
    if (!limite.allowed) {
      const { NextResponse } = await import("next/server");
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, error: "Trop de battements machine — ralentissez." },
          { status: 429 },
        ),
      };
    }
    return {
      ok: true,
      context: {
        userId: UTILISATEUR_NOEUD_SERVICE,
        traceId: `noeud-${Date.now().toString(36)}`,
      },
    };
  }
  // Credential utilisateur (Firebase) — la voie historique inchangée.
  return protectRoute(request);
}
