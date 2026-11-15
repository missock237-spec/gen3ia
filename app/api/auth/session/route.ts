import { NextRequest, NextResponse } from "next/server";
import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { ensureIdentity, publicIdentity } from "@/lib/identity/service";
import { getWallet } from "@/lib/billing/wallet";
import {
  clearSessionCookieHeader,
  readSessionCookie,
  sessionCookieHeader,
} from "@/lib/server/session-cookie";
import { logger } from "@/lib/observability/logger";
import { mfaStatusFromToken } from "@/lib/security/mfa";

interface SessionWallet {
  currency: string;
  balanceMinor: number;
  availableMinor: number;
  reservedMinor: number;
  welcomeGranted: boolean;
}

interface SessionResponseBody {
  authenticated: boolean;
  /** true : jeton valide mais provisioning indisponible (mode dégradé). */
  degraded?: boolean;
  /** true : session établie après un second facteur MFA vérifié (Task 63). */
  mfa?: boolean;
  user: {
    uid: string;
    email: string | null;
    name: string | null;
    picture: string | null;
    /** Thème persisté dans l'identité R2 (contrat lot 108-c) — champ additionnel. */
    theme?: string;
  };
  /** null uniquement en mode dégradé : le wallet se recharge plus tard. */
  wallet: SessionWallet | null;
}

/**
 * Provisionne identité (base R2) + wallet. Chaque étape est isolée : une panne
 * de la base d'identités ou du wallet NE DOIT PAS invalider une authentification
 * Firebase par ailleurs valide (bug historique : "database was deleted" rendait
 * la connexion impossible pour TOUS les utilisateurs). En mode dégradé la
 * session est établie, l'identité/wallet seront provisionnés à la prochaine
 * opportunité.
 */
async function provisionnerUtilisateur(token: {
  uid: string;
  email?: string;
  /** Claim Firebase email_verified : autorité serveur pour l'email. */
  email_verified?: boolean;
  name?: string;
  picture?: string;
  firebase?: { sign_in_provider?: string };
}): Promise<{ wallet: SessionWallet | null; degraded: boolean; theme?: string }> {
  const provider = token.firebase?.sign_in_provider || "unknown";
  let degraded = false;
  let wallet: SessionWallet | null = null;
  let theme: string | undefined;

  try {
    const identity = await ensureIdentity({
      uid: token.uid,
      email: token.email ?? null,
      // Jeton portant un email vérifié → mutation serveur autorisée
      // (l'email fait autorité, il écrase un email non vérifié antérieur).
      emailVerified: token.email_verified === true,
      displayName: token.name ?? null,
      photoURL: token.picture ?? null,
      provider,
    });
    theme = publicIdentity(identity).theme;
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: token.uid }, "auth.session.identity_provision_failed_degraded");
  }

  try {
    const snap = await getWallet(token.uid);
    wallet = {
      currency: snap.currency,
      balanceMinor: snap.balanceMinor,
      availableMinor: snap.availableMinor,
      reservedMinor: snap.reservedMinor,
      welcomeGranted: snap.welcomeGranted,
    };
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: token.uid }, "auth.session.wallet_read_failed_degraded");
  }

  return { wallet, degraded, theme };
}

export async function POST(request: NextRequest) {
  try {
    const ipLimit = await enforceRateLimit(`auth-session:${clientIp(request)}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!ipLimit.allowed) {
      return NextResponse.json({ authenticated: false, error: "Trop de tentatives de session. Reessayez plus tard." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(ipLimit.retryAfterMs / 1000))) } });
    }
  } catch {
    // le limiteur ne doit jamais bloquer la connexion
  }

  try {
    const token = await verifyFirebaseToken(request.headers.get("authorization"));
    const provider = token.firebase?.sign_in_provider || "unknown";
    // Preuve MFA (Task 63) : recopiée dans le cookie de session signé — les
    // surfaces sensibles (assertStrongAuth) s'y fient pour les sessions cookie.
    const mfaStatus = mfaStatusFromToken(token);

    const { wallet, degraded, theme } = await provisionnerUtilisateur(token);

    const body: SessionResponseBody = {
      authenticated: true,
      ...(degraded ? { degraded: true } : {}),
      mfa: mfaStatus.secondFactorUsed,
      user: {
        uid: token.uid,
        email: token.email ?? null,
        name: token.name ?? null,
        picture: token.picture ?? null,
        ...(theme ? { theme } : {}),
      },
      wallet,
    };

    // Cookie de session signe : garde-fou si l'etat Firebase client disparait
    // (navigateurs mobiles, webviews, stockage partitionne). Pose DES QUE le
    // jeton est valide — même en mode dégradé.
    return NextResponse.json(body, {
      headers: {
        "Set-Cookie": sessionCookieHeader({
          uid: token.uid,
          email: token.email ?? null,
          name: token.name ?? null,
          picture: token.picture ?? null,
          provider,
          ...(mfaStatus.secondFactorUsed ? { mfa: true } : {}),
        }),
      },
    });
  } catch (error) {
    // Ici on ne passe que si le JETON Firebase lui-même est invalide :
    // 401 est sémantiquement correct.
    return NextResponse.json({ authenticated: false, error: error instanceof Error ? error.message : "Authentication failed." }, { status: 401 });
  }
}

/**
 * Version cookie : repond a partir du cookie de session signe pose par POST.
 * Utilisee par les pages protegees lorsque l'etat Firebase client est
 * indisponible, afin que l'utilisateur authentifie accede quand meme au
 * tableau de bord. Une panne de la base d'identités/wallet renvoie
 * 200 + wallet:null (mode dégradé) au lieu d'un 401 qui déconnecterait
 * l'utilisateur.
 */
export async function GET(request: NextRequest) {
  const session = readSessionCookie(request.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const { wallet, degraded, theme } = await provisionnerUtilisateur({
    uid: session.uid,
    email: session.email ?? undefined,
    name: session.name ?? undefined,
    picture: session.picture ?? undefined,
    firebase: { sign_in_provider: session.provider },
  });

  const body: SessionResponseBody = {
    authenticated: true,
    ...(degraded ? { degraded: true } : {}),
    user: {
      uid: session.uid,
      email: session.email,
      name: session.name,
      picture: session.picture,
      ...(theme ? { theme } : {}),
    },
    wallet,
  };
  return NextResponse.json(body);
}

export async function DELETE() {
  return new NextResponse(null, {
    status: 204,
    headers: { "Set-Cookie": clearSessionCookieHeader() },
  });
}
