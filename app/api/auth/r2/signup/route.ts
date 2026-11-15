import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/logger";
import { ensureIdentity } from "@/lib/identity/service";
import { getWallet } from "@/lib/billing/wallet";
import { storePermanentFile } from "@/lib/storage/permanent-user-storage";
import { sessionCookieHeader } from "@/lib/server/session-cookie";
import {
  R2_ACCOUNT_PROVIDER,
  R2AuthError,
  createR2Account,
} from "@/lib/auth/r2-accounts";

/**
 * Task 151 — INSCRIPTION PAR COMPTE NATIF R2.
 *
 * POST /api/auth/r2/signup { email, password, firstName, lastName, username,
 * country?, language?, timezone? }
 *
 * Le compte est créé DANS R2 (identifiants stockés côté serveur, hash
 * scrypt — cf. lib/auth/r2-accounts.ts). À l'ouverture du compte :
 *   · l'identité plateforme est provisionnée (ensureIdentity, R2) ;
 *   · le wallet de démonstration est crédité (getWallet — welcome) ;
 *   · l'ESPACE DE STOCKAGE R2 de l'utilisateur s'ouvre : un fichier de
 *     bienvenue est déposé dans users/<uid>/permanent/ (visible sur la
 *     page Stockage, supprimable) ;
 *   · le quota offert est de 1 Go (plan free de lib/storage/plans.ts,
 *     appliqué dynamiquement — getQuotaBytesForUser).
 *
 * La session est établie par le cookie signé `gen3ia_session`
 * (provider « r2-password ») : l'utilisateur est reconnu par ses
 * identifiants sur TOUTES les surfaces de la plateforme (requireUser /
 * cookie de session), sans Firebase.
 *
 * Philosophie alignée sur /api/auth/session : une panne du provisionnement
 * (identité, wallet, espace) ne doit JAMAIS invalider une inscription par
 * ailleurs valide — mode dégradé (degraded:true), session quand même posée.
 */

const SignupSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/, "Nom d'utilisateur invalide."),
  country: z.string().trim().max(80).optional(),
  language: z.string().trim().max(16).optional(),
  timezone: z.string().trim().max(80).optional(),
});

interface SessionWallet {
  currency: string;
  balanceMinor: number;
  availableMinor: number;
  reservedMinor: number;
  welcomeGranted: boolean;
}

const WELCOME_FILE_NAME = "Bienvenue dans votre espace Gen3ia.txt";
const WELCOME_FILE_CONTENT = [
  "Bienvenue sur Gen3ia !",
  "",
  "Cet espace de stockage personnel vient de s'ouvrir pour votre compte.",
  "Quota offert : 1 Go (extensible à 5 Go pour 2,50 EUR/mois ou 10 Go pour",
  "5 EUR/mois depuis la page Stockage).",
  "",
  "Tout ce que vous déposez ici est conservé dans VOTRE espace privé :",
  "les pièces jointes du chat, les captures, la mémoire permanente. Vous",
  "pouvez lister et supprimer définitivement vos fichiers à tout moment",
  "depuis la page Stockage pour libérer de l'espace.",
  "",
  "Vous pouvez supprimer ce message : il ne sert qu'à matérialiser votre",
  "espace de départ.",
].join("\n");

export async function POST(request: NextRequest) {
  try {
    const ipLimit = await enforceRateLimit(`auth-r2-signup:${clientIp(request)}`, {
      limit: 10,
      windowMs: 10 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { authenticated: false, error: "Trop de tentatives d'inscription. Réessayez plus tard." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, Math.ceil(ipLimit.retryAfterMs / 1000))) },
        },
      );
    }
  } catch {
    // le limiteur ne doit jamais bloquer l'inscription
  }

  let body: z.infer<typeof SignupSchema>;
  try {
    body = SignupSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { authenticated: false, error: "Inscription invalide : vérifiez le prénom, le nom, le nom d'utilisateur et le mot de passe (8 caractères minimum)." },
      { status: 400 },
    );
  }

  let account;
  try {
    account = await createR2Account({
      email: body.email,
      password: body.password,
      displayName: `${body.firstName} ${body.lastName}`.replace(/\s+/g, " ").trim(),
      username: body.username,
    });
  } catch (error) {
    if (error instanceof R2AuthError) {
      return NextResponse.json({ authenticated: false, error: error.message }, { status: error.status });
    }
    logger.error({ err: error }, "auth.r2.signup.account_creation_failed");
    return NextResponse.json(
      { authenticated: false, error: "La création du compte a échoué côté stockage. Réessayez dans un instant." },
      { status: 503 },
    );
  }

  // ---- Provisionnement (chaque étape isolée : pannes non bloquantes) ----
  let degraded = false;
  let wallet: SessionWallet | null = null;

  try {
    await ensureIdentity({
      uid: account.uid,
      email: account.email,
      emailVerified: false,
      displayName: account.displayName,
      firstName: body.firstName,
      lastName: body.lastName,
      username: body.username,
      country: body.country ?? null,
      language: body.language ?? "fr",
      timezone: body.timezone ?? "UTC",
      provider: R2_ACCOUNT_PROVIDER,
    });
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: account.uid }, "auth.r2.signup.identity_provision_failed_degraded");
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
    logger.warn({ err: error, uid: account.uid }, "auth.r2.signup.wallet_read_failed_degraded");
  }

  // Ouverture matérielle de l'espace de stockage R2 de l'utilisateur :
  // le fichier de bienvenue matérialise users/<uid>/permanent/ (fail-soft —
  // l'espace s'ouvre de toute façon au premier dépôt).
  try {
    await storePermanentFile({
      userId: account.uid,
      filename: WELCOME_FILE_NAME,
      content: Buffer.from(WELCOME_FILE_CONTENT, "utf8"),
      contentType: "text/plain",
    });
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: account.uid }, "auth.r2.signup.welcome_file_failed_degraded");
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
