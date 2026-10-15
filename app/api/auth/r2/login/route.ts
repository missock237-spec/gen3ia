import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/logger";
import { ensureIdentity } from "@/lib/identity/service";
import { getWallet } from "@/lib/billing/wallet";
import { sessionCookieHeader } from "@/lib/server/session-cookie";
import {
  R2_ACCOUNT_PROVIDER,
  R2AuthError,
  authenticateR2Account,
} from "@/lib/auth/r2-accounts";

/**
 * Task 151 — CONNEXION PAR IDENTIFIANTS DE COMPTE R2.
 *
 * POST /api/auth/r2/login { email, password }
 *
 * Les identifiants sont vérifiés contre le compte stocké dans R2 (hash
 * scrypt — lib/auth/r2-accounts.ts). Succès → cookie de session signé
 * `gen3ia_session` (provider « r2-password », 30 jours) : l'utilisateur
 * est reconnu par ses identifiants sur toutes les surfaces protégées
 * (requireUser accepte le cookie partout sur la plateforme).
 *
 * Double limite de débit : par IP (30/5 min) et par e-mail (8/5 min) —
 * atténuation du bourrage d'identifiants. Les échecs renvoient un message
 * unique (aucune énumération de comptes).
 *
 * Mode dégradé (aligné sur /api/auth/session) : une panne du provisionnement
 * n'invalide JAMAIS une connexion par ailleurs valide.
 */

const LoginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

interface SessionWallet {
  currency: string;
  balanceMinor: number;
  availableMinor: number;
  reservedMinor: number;
  welcomeGranted: boolean;
}

export async function POST(request: NextRequest) {
  let ipOk = true;
  try {
    const ipLimit = await enforceRateLimit(`auth-r2-login-ip:${clientIp(request)}`, {
      limit: 30,
      windowMs: 5 * 60 * 1000,
    });
    if (!ipLimit.allowed) ipOk = false;
  } catch {
    // le limiteur ne doit jamais bloquer la connexion
  }
  if (!ipOk) {
    return NextResponse.json(
      { authenticated: false, error: "Trop de tentatives de connexion. Réessayez dans quelques minutes." },
      { status: 429, headers: { "retry-after": "120" } },
    );
  }

  let body: z.infer<typeof LoginSchema>;
  try {
    body = LoginSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { authenticated: false, error: "E-mail ou mot de passe incorrect." },
      { status: 400 },
    );
  }

  // Bourrage d'identifiants : plafond serré PAR E-MAIL (indépendant de l'IP,
  // qui peut être partagée — NAT, proxy d'entreprise).
  try {
    const emailLimit = await enforceRateLimit(
      `auth-r2-login-email:${body.email.trim().toLowerCase()}`,
      { limit: 8, windowMs: 5 * 60 * 1000 },
    );
    if (!emailLimit.allowed) {
      return NextResponse.json(
        { authenticated: false, error: "Trop de tentatives pour ce compte. Réessayez dans quelques minutes." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, Math.ceil(emailLimit.retryAfterMs / 1000))) },
        },
      );
    }
  } catch {
    // le limiteur ne doit jamais bloquer la connexion
  }

  let account;
  try {
    account = await authenticateR2Account({ email: body.email, password: body.password });
  } catch (error) {
    if (error instanceof R2AuthError) {
      return NextResponse.json({ authenticated: false, error: error.message }, { status: error.status });
    }
    logger.error({ err: error }, "auth.r2.login.storage_failed");
    return NextResponse.json(
      { authenticated: false, error: "La vérification des identifiants est indisponible. Réessayez dans un instant." },
      { status: 503 },
    );
  }

  // ---- Provisionnement (pannes non bloquantes, comme /api/auth/session) ----
  let degraded = false;
  let wallet: SessionWallet | null = null;

  try {
    await ensureIdentity({
      uid: account.uid,
      email: account.email,
      emailVerified: false,
      displayName: account.displayName,
      username: account.username,
      provider: R2_ACCOUNT_PROVIDER,
    });
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: account.uid }, "auth.r2.login.identity_provision_failed_degraded");
  }

  try {
    const snap = await getWallet(account.uid);
    wallet = {
      currency: snap.currency,
      balanceMinor: snap.balanceMinor,
      availableMinor: snap.availableMinor,
      reservedMinor: snap.reservedMinor,
      welcomeGranted: snap.welcomeGranted,
    };
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: account.uid }, "auth.r2.login.wallet_read_failed_degraded");
  }

  return NextResponse.json(
    {
      authenticated: true,
      ...(degraded ? { degraded: true } : {}),
      user: {
        uid: account.uid,
        email: account.email,
        name: account.displayName,
        picture: null,
      },
      wallet,
    },
    {
      headers: {
        "Set-Cookie": sessionCookieHeader({
          uid: account.uid,
          email: account.email,
          name: account.displayName,
          picture: null,
          provider: R2_ACCOUNT_PROVIDER,
        }),
      },
    },
  );
}
