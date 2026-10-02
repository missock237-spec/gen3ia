import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { isMfaRequiredForUser, setMfaRequirement } from "@/lib/security/mfa";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PayloadSchema = z.object({
  uid: z.string().trim().min(1).max(128),
  required: z.boolean(),
});

/**
 * POST /api/admin/security/mfa-requirement — politique « MFA requis » par
 * compte (Task 63, admin uniquement).
 *
 * Un compte marqué doit présenter un second facteur vérifié (TOTP) pour les
 * surfaces sensibles (assertStrongAuth — rechargements wallet, sécurité,
 * actions admin critiques). L'inscription du facteur elle-même exige
 * Identity Platform (voir docs/enterprise-security.md) : tant qu'il n'est
 * pas activé, la route refuse de poser le flag — sinon on verrouillerait un
 * compte qui ne peut pas s'enregistrer (garde anti-locked-out).
 *
 * GET ?uid=… — lit l'état courant (admin uniquement).
 *
 * JOURNAL : l'admin console Firestore reste la source d'audit (collection
 * users/{uid}.mfaRequiredUpdatedAt) ; une entrée dédiée `mfaAuditLogs`
 * est écrite ici avec l'acteur, la cible et l'état précédent.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const uid = request.nextUrl.searchParams.get("uid")?.trim();
  if (!uid) {
    return NextResponse.json({ error: "Paramètre uid requis." }, { status: 400 });
  }
  return NextResponse.json({ uid, mfaRequired: await isMfaRequiredForUser(uid) });
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const parsed = PayloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload invalide : { uid, required }." }, { status: 400 });
  }
  const { uid, required } = parsed.data;

  // Garde anti-verrouillage : impossible d'exiger le MFA d'un compte tant que
  // l'enrôlement TOTP n'est pas disponible (Identity Platform activé, signal
  // par env). Poser le flag sans enrôlement possible = compte bloqué sur les
  // actions sensibles sans aucune voie de réparation.
  if (required && process.env.FIREBASE_AUTH_IDENTITY_PLATFORM_ENABLED?.trim() !== "true") {
    return NextResponse.json(
      {
        error:
          "Identity Platform n'est pas activé (FIREBASE_AUTH_IDENTITY_PLATFORM_ENABLED!=true) : l'enrôlement TOTP est impossible pour ce compte. Activez Identity Platform puis posez le flag.",
      },
      { status: 409 },
    );
  }

  try {
    const { previous } = await setMfaRequirement(uid, required);
    // Journal d'audit dédié (écriture best-effort : l'échec ne casse pas
    // l'opération, l'état users/{uid} fait foi).
    const { adminDb } = await import("@/lib/firebase/admin");
    await adminDb
      .collection("mfaAuditLogs")
      .add({
        actorId: admin.uid,
        targetUserId: uid,
        required,
        previous,
        at: new Date(),
      })
      .catch(() => undefined);

    return NextResponse.json({ uid, mfaRequired: required, previous });
  } catch (error) {
    return NextResponse.json(
      errorBody(error, "Mise à jour de la politique MFA impossible."),
      { status: errorStatus(error, 500) },
    );
  }
}
