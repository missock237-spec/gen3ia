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

interface SessionResponseBody {
  authenticated: boolean;
  user: {
    uid: string;
    email: string | null;
    name: string | null;
    picture: string | null;
  };
  wallet: {
    currency: string;
    balanceMinor: number;
    availableMinor: number;
    reservedMinor: number;
    welcomeGranted: boolean;
  };
}

export async function POST(request: NextRequest) {
  try {
    const ipLimit = rateLimit(`auth-session:${clientIp(request)}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!ipLimit.allowed) {
      return NextResponse.json({ authenticated: false, error: "Trop de tentatives de session. Reessayez plus tard." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(ipLimit.retryAfterMs / 1000))) } });
    }
    const token = await verifyFirebaseToken(request.headers.get("authorization"));
    const provider = token.firebase?.sign_in_provider || "unknown";
    await ensureUserProfile({ uid: token.uid, email: token.email, displayName: token.name, photoURL: token.picture, provider });
    const wallet = await getWallet(token.uid);
    const body: SessionResponseBody = {
      authenticated: true,
      user: { uid: token.uid, email: token.email ?? null, name: token.name ?? null, picture: token.picture ?? null },
      wallet: { currency: wallet.currency, balanceMinor: wallet.balanceMinor, availableMinor: wallet.availableMinor, reservedMinor: wallet.reservedMinor, welcomeGranted: wallet.welcomeGranted },
    };

    // Cookie de session signe : garde-fou si l'etat Firebase client disparait
    // (navigateurs mobiles, webviews, stockage partitionne).
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
    return NextResponse.json({ authenticated: false, error: error instanceof Error ? error.message : "Authentication failed." }, { status: 401 });
  }
}

/**
 * Version cookie : repond a partir du cookie de session signe pose par POST.
 * Utilisee par les pages protegees lorsque l'etat Firebase client est
 * indisponible, afin que l'utilisateur authentifie accede quand meme au
 * tableau de bord.
 */
export async function GET(request: NextRequest) {
  const session = readSessionCookie(request.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  try {
    const wallet = await getWallet(session.uid);
    const body: SessionResponseBody = {
      authenticated: true,
      user: { uid: session.uid, email: session.email, name: session.name, picture: session.picture },
      wallet: { currency: wallet.currency, balanceMinor: wallet.balanceMinor, availableMinor: wallet.availableMinor, reservedMinor: wallet.reservedMinor, welcomeGranted: wallet.welcomeGranted },
    };
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      { authenticated: false, error: error instanceof Error ? error.message : "Session check failed." },
      { status: 401 },
    );
  }
}

export async function DELETE() {
  return new NextResponse(null, {
    status: 204,
    headers: { "Set-Cookie": clearSessionCookieHeader() },
  });
}
