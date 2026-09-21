import { NextRequest, NextResponse } from "next/server";
import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { clientIp, rateLimit } from "@/lib/security/rate-limit";
import { ensureUserProfile } from "@/lib/firebase/users";
import { getWallet } from "@/lib/billing/wallet";
import {
  clearSessionCookieHeader,
  readSessionCookie,
  sessionCookieHeader,
} from "@/lib/server/session-cookie";
import { logger } from "@/lib/observability/logger";

interface SessionWallet {
  currency: string;
  balanceMinor: number;
  availableMinor: number;
  reservedMinor: number;
  welcomeGranted: boolean;
}

interface SessionResponseBody {
  authenticated: boolean;
  /** true : jeton valide mais provisioning Firestore indisponible (mode dégradé). */
  degraded?: boolean;
  user: {
    uid: string;
    email: string | null;
    name: string | null;
    picture: string | null;
  };
  /** null uniquement en mode dégradé : le wallet se recharge plus tard. */
  wallet: SessionWallet | null;
}

/**
 * Provisionne profil + wallet. Chaque étape est isolée : une panne Firestore
 * NE DOIT PAS invalider une authentification Firebase par ailleurs valide
 * (bug historique : "database was deleted" rendait la connexion impossible
 * pour TOUS les utilisateurs). En mode dégradé la session est établie, le
 * profil/wallet seront provisionnés à la prochaine opportunité.
 */
async function provisionnerUtilisateur(token: {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  firebase?: { sign_in_provider?: string };
}): Promise<{ wallet: SessionWallet | null; degraded: boolean }> {
  const provider = token.firebase?.sign_in_provider || "unknown";
  let degraded = false;
  let wallet: SessionWallet | null = null;

  try {
    await ensureUserProfile({ uid: token.uid, email: token.email, displayName: token.name, photoURL: token.picture, provider });
  } catch (error) {
    degraded = true;
    logger.warn({ err: error, uid: token.uid }, "auth.session.profile_provision_failed_degraded");
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

  return { wallet, degraded };
}

export async function POST(request: NextRequest) {
  let rateLimitResponse: NextResponse | null = null;
  try {
    const ipLimit = rateLimit(`auth-session:${clientIp(request)}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!ipLimit.allowed) {
      return NextResponse.json({ authenticated: false, error: "Trop de tentatives de session. Reessayez plus tard." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(ipLimit.retryAfterMs / 1000))) } });
    }
  } catch {
    rateLimitResponse = null; // le limiteur ne doit jamais bloquer la connexion
  }

  try {
    const token = await verifyFirebaseToken(request.headers.get("authorization"));
    const provider = token.firebase?.sign_in_provider || "unknown";

    const { wallet, degraded } = await provisionnerUtilisateur(token);

    const body: SessionResponseBody = {
      authenticated: true,
      ...(degraded ? { degraded: true } : {}),
      user: { uid: token.uid, email: token.email ?? null, name: token.name ?? null, picture: token.picture ?? null },
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
 * tableau de bord. Une panne Firestore renvoie 200 + wallet:null (mode
 * dégradé) au lieu d'un 401 qui déconnecterait l'utilisateur.
 */
export async function GET(request: NextRequest) {
  const session = readSessionCookie(request.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const { wallet, degraded } = await provisionnerUtilisateur({
    uid: session.uid,
    email: session.email ?? undefined,
    name: session.name ?? undefined,
    picture: session.picture ?? undefined,
    firebase: { sign_in_provider: session.provider },
  });

  const body: SessionResponseBody = {
    authenticated: true,
    ...(degraded ? { degraded: true } : {}),
    user: { uid: session.uid, email: session.email, name: session.name, picture: session.picture },
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
