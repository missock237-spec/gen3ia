import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/logger";
import {
  R2AuthError,
  consumePasswordResetToken,
  updateR2AccountPassword,
} from "@/lib/auth/r2-accounts";

/**
 * Task 151 — CONFIRMATION DE RÉINITIALISATION DE MOT DE PASSE (comptes R2).
 *
 * POST /api/auth/r2/password-reset/confirm { token, newPassword }
 *
 * Le jeton est à usage unique (le document R2 est consommé même en cas
 * d'échec ultérieur) et vivant 30 minutes. Le nouveau mot de passe remplace
 * le hash scrypt du compte — l'utilisateur peut alors se connecter avec ses
 * nouveaux identifiants (POST /api/auth/r2/login).
 */

const ConfirmSchema = z.object({
  token: z.string().trim().regex(/^[a-f0-9]{64}$/, "Lien invalide."),
  newPassword: z.string().min(8).max(128),
});

export async function POST(request: NextRequest) {
  try {
    const ipLimit = await enforceRateLimit(`auth-r2-reset-confirm:${clientIp(request)}`, {
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { ok: false, error: "Trop de tentatives. Réessayez plus tard." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, Math.ceil(ipLimit.retryAfterMs / 1000))) },
        },
      );
    }
  } catch {
    // le limiteur ne doit jamais bloquer la confirmation
  }

  let body: z.infer<typeof ConfirmSchema>;
  try {
    body = ConfirmSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { ok: false, error: "Nouveau mot de passe invalide (8 caractères minimum) ou lien malformé." },
      { status: 400 },
    );
  }

  try {
    const account = await consumePasswordResetToken(body.token);
    await updateR2AccountPassword(account.uid, body.newPassword);
    return NextResponse.json({
      ok: true,
      message: "Mot de passe modifié. Vous pouvez vous connecter avec vos nouveaux identifiants.",
    });
  } catch (error) {
    if (error instanceof R2AuthError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    logger.error({ err: error }, "auth.r2.reset.confirm_failed");
    return NextResponse.json(
      { ok: false, error: "La modification du mot de passe a échoué. Réessayez dans un instant." },
      { status: 503 },
    );
  }
}
