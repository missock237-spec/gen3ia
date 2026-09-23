import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { ensureUserProfile } from "@/lib/firebase/users";
import { errorStatus } from "@/lib/security/http-errors";

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

export async function POST(request: NextRequest) {
  try {
    const token = await verifyFirebaseToken(request.headers.get("authorization"));
    const body = ProfileSchema.parse(await request.json());

    await ensureUserProfile({
      uid: token.uid,
      email: token.email,
      firstName: body.firstName,
      lastName: body.lastName,
      displayName: `${body.firstName} ${body.lastName}`,
      username: body.username,
      phoneNumber: body.phoneNumber,
      country: body.country,
      bio: body.bio,
      language: body.language,
      timezone: body.timezone,
      photoURL: body.photoURL,
      provider: token.firebase?.sign_in_provider || "unknown",
    });

    return NextResponse.json({ ok: true, userId: token.uid });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: "Profil invalide.", details: error.issues }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Impossible d'enregistrer le profil." }, { status: errorStatus(error, 500) });
  }
}
