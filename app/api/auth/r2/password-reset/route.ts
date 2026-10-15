import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/logger";
import { getAppUrl } from "@/lib/url/app-url";
import { createPasswordResetToken, PASSWORD_RESET_TTL_MS } from "@/lib/auth/r2-accounts";

/**
 * Task 151 — DEMANDE DE RÉINITIALISATION DE MOT DE PASSE (comptes R2).
 *
 * POST /api/auth/r2/password-reset { email }
 *
 * Réponse TOUJOURS identique que le compte existe ou non (aucune
 * énumération d'adresses). Si le compte existe, un e-mail est envoyé via
 * Resend avec un lien à usage unique valable 30 minutes :
 *   <app>/login?reset=<token>
 * La confirmation passe par POST /api/auth/r2/password-reset/confirm.
 *
 * L'envoi est DIRECT (fetch Resend, sans facturation d'usage : la demande
 * provient d'un utilisateur NON authentifié — on ne débite personne pour
 * retrouver son mot de passe).
 */

const ResetRequestSchema = z.object({
  email: z.string().trim().min(3).max(254),
});

const GENERIC_MESSAGE =
  "Si un compte existe avec cette adresse, un e-mail de réinitialisation vient d'être envoyé (valable 30 minutes). Consultez votre boîte de réception et vos spams.";

function isEmailProviderConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM_ADDRESS?.trim());
}

async function sendResetEmail(email: string, token: string): Promise<void> {
  const origin = getAppUrl();
  const link = `${origin}/login?reset=${token}`;
  const minutes = Math.round(PASSWORD_RESET_TTL_MS / 60_000);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM_ADDRESS!.trim(),
      to: [email],
      subject: "Gen3ia — réinitialisation de votre mot de passe",
      text: [
        "Bonjour,",
        "",
        "Vous avez demandé la réinitialisation du mot de passe de votre compte Gen3ia.",
        `Ouvrez ce lien pour choisir un nouveau mot de passe (valable ${minutes} minutes, usage unique) :`,
        link,
        "",
        "Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail :",
        "votre mot de passe actuel reste inchangé.",
        "",
        "— L'équipe Gen3ia",
      ].join("\n"),
      html: [
        "<div style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a\">",
        "<h2 style=\"margin:0 0 16px\">Réinitialisation de votre mot de passe Gen3ia</h2>",
        "<p style=\"margin:0 0 12px\">Bonjour,</p>",
        "<p style=\"margin:0 0 16px\">Vous avez demandé la réinitialisation du mot de passe de votre compte Gen3ia. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</p>",
        `<p style=\"margin:0 0 16px\"><a href="${link}" style="display:inline-block;background:#7c5cff;color:#ffffff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:600">Choisir un nouveau mot de passe</a></p>`,
        `<p style=\"margin:0 0 8px;font-size:13px;color:#666\">Ce lien est valable ${minutes} minutes et ne peut servir qu'une fois.</p>`,
        "<p style=\"margin:0;font-size:13px;color:#666\">Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe actuel reste inchangé.</p>",
        "</div>",
      ].join(""),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Resend API error: ${String(payload.message ?? response.status).slice(0, 200)}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const ipLimit = await enforceRateLimit(`auth-r2-reset:${clientIp(request)}`, {
      limit: 10,
      windowMs: 10 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { ok: false, error: "Trop de demandes. Réessayez plus tard." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, Math.ceil(ipLimit.retryAfterMs / 1000))) },
        },
      );
    }
  } catch {
    // le limiteur ne doit jamais bloquer la demande
  }

  let body: z.infer<typeof ResetRequestSchema>;
  try {
    body = ResetRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
  }

  try {
    const token = await createPasswordResetToken(body.email);
    // Compte introuvable OU e-mail malformé : réponse identique (anti-énumération).
    if (token && isEmailProviderConfigured()) {
      await sendResetEmail(body.email.trim().toLowerCase(), token);
    } else if (token) {
      // Provider non configuré : loggué pour l'exploitation, réponse inchangée.
      logger.warn("auth.r2.reset.email_provider_not_configured");
    }
  } catch (error) {
    // Un incident d'envoi ne doit révéler AUCUNE information : même réponse.
    logger.error({ err: error }, "auth.r2.reset.send_failed");
  }

  return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
}
