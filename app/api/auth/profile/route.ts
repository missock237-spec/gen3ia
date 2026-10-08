import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { errorStatus } from "@/lib/security/http-errors";
import { requireUser } from "@/lib/security/authenticated-request";
import {
  ensureIdentity,
  identityErrorStatus,
  updateIdentity,
} from "@/lib/identity/service";
import { getIdentity } from "@/lib/identity/r2-identity-store";
import type { Identity, IdentityPatch } from "@/lib/identity/schema";

/**
 * Task 108-b — profil utilisateur sur la base d'identités R2.
 *
 * - POST : contrat d'INSCRIPTION historique (lib/firebase/auth-client.ts,
 *   hors lot) — préservé à l'identique, il provisionne désormais l'identité
 *   dans R2 (au lieu de users/{uid} Firestore).
 * - GET : identité COMPLÈTE de l'appelant — uid pris UNIQUEMENT du jeton
 *   (requireUser : Bearer Firebase ou cookie de session signé) ; cloisonnement
 *   propriétaire par construction, aucun uid ne vient du corps de requête.
 * - PUT : patch utilisateur (IdentityPatch) — accepte theme: "light"|"dark"
 *   (CONTRAT lot 108-c) ; email/role/plan/status ignorés (mutations serveur).
 * Une panne R2 renvoie 503 (mode dégradé), un profil non provisionné → 404.
 */

const ProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/),
  phoneNumber: z.string().trim().max(40).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  language: z.string().trim().max(16).optional(),
  timezone: z.string().trim().max(80).optional(),
  photoURL: z.string().url().max(2048).nullable().optional(),
});

/** Message FR unique pour un échec de lecture/écriture du profil. */
function messageErreur(error: unknown, repli: string): string {
  return error instanceof Error && error.message ? error.message : repli;
}

export async function POST(request: NextRequest) {
  try {
    const token = await verifyFirebaseToken(request.headers.get("authorization"));
    const body = ProfileSchema.parse(await request.json());

    await ensureIdentity({
      uid: token.uid,
      email: token.email ?? null,
      // Jeton d'inscription : un email vérifié fait autorité (mutation serveur).
      emailVerified: token.email_verified === true,
      displayName: `${body.firstName} ${body.lastName}`.replace(/\s+/g, " ").trim(),
      firstName: body.firstName,
      lastName: body.lastName,
      username: body.username,
      phoneNumber: body.phoneNumber ?? null,
      country: body.country ?? null,
      bio: body.bio ?? null,
      language: body.language ?? null,
      timezone: body.timezone ?? null,
      photoURL: body.photoURL ?? null,
      provider: token.firebase?.sign_in_provider || "unknown",
    });

    return NextResponse.json({ ok: true, userId: token.uid });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: "Profil invalide.", details: error.issues }, { status: 400 });
    }
    const statut = identityErrorStatus(error);
    return NextResponse.json(
      { ok: false, error: messageErreur(error, "Impossible d'enregistrer le profil.") },
      { status: statut ?? errorStatus(error, 500) },
    );
  }
}

/** Identité complète de l'appelant (uid du jeton UNIQUEMENT). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const identity: Identity | null = await getIdentity(user.uid);
    if (!identity) {
      return NextResponse.json(
        { ok: false, error: "Profil introuvable : il sera provisionné lors de votre prochaine connexion." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, userId: user.uid, identity });
  } catch (error) {
    const statut = identityErrorStatus(error);
    return NextResponse.json(
      { ok: false, error: messageErreur(error, "Impossible de lire le profil.") },
      { status: statut ?? errorStatus(error, 500) },
    );
  }
}

/** Mise à jour du profil : IdentityPatch strict (champs inconnus → 422). */
export async function PUT(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // Le parse strict a lieu DANS updateIdentity (après filtrage des champs
    // immutables — un client qui renvoie l'objet complet n'est pas puni).
    const brut: unknown = await request.json();
    const identity = await updateIdentity(user.uid, brut as IdentityPatch);
    return NextResponse.json({ ok: true, userId: user.uid, theme: identity.theme });
  } catch (error) {
    const statut = identityErrorStatus(error);
    return NextResponse.json(
      { ok: false, error: messageErreur(error, "Impossible d'enregistrer le profil.") },
      { status: statut ?? errorStatus(error, 500) },
    );
  }
}
