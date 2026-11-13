import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { listerClients, revoquerClient } from "@/lib/genapi/clients";
import { provisionnerClient } from "@/lib/genapi/provisionnement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validation basique d'une adresse email (le socle revalide de son côté). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CorpsGenAPIPost {
  action?: string;
  uid?: string;
  email?: string;
}

/**
 * GET /api/admin/genapi/clients — registre des clients genAPI provisionnés
 * (uid, email, empreinte du certificat, statut, dates). Admin uniquement.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  try {
    const clients = await listerClients();
    return NextResponse.json({ clients }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(errorBody(error, "genAPI indisponible : impossible de lister les clients."), { status: 500 });
  }
}

/**
 * POST /api/admin/genapi/clients — actions du cycle de vie client :
 *  - { action: "provisionner", uid, email } : provisionne un certificat
 *    client mTLS via le Master Daemon et délivre un lien de paquet à usage
 *    unique (trigger "console_admin" pour la facturation Chariow) ;
 *  - { action: "revoquer", uid } : révoque le certificat du client.
 *
 * Contrat de statut : un REFUS MÉTIER (CA indisponible, client déjà
 * provisionné, budget Chariow insuffisant…) répond 200 avec ok:false —
 * JAMAIS un 500, qui signifierait une panne technique. Seule une erreur
 * technique du socle tombe en 500 propre.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  let corps: CorpsGenAPIPost;
  try {
    corps = (await request.json()) as CorpsGenAPIPost;
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide : attendu { uid, email, action }." }, { status: 400 });
  }

  const action = typeof corps.action === "string" ? corps.action : "";
  const uid = typeof corps.uid === "string" ? corps.uid.trim() : "";
  const email = typeof corps.email === "string" ? corps.email.trim() : "";

  if (action === "provisionner") {
    if (!uid) {
      return NextResponse.json({ error: "Champ « uid » requis pour provisionner un client genAPI." }, { status: 400 });
    }
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Champ « email » requis (adresse valide) pour provisionner un client genAPI." }, { status: 400 });
    }
    try {
      const resultat = await provisionnerClient({ uid, email, trigger: "console_admin" });
      // ok:false = décision métier du socle → 200 honnête (le message
      // d'erreur est transporté dans resultat.erreur).
      return NextResponse.json(resultat, { status: 200 });
    } catch (error) {
      return NextResponse.json(errorBody(error, "genAPI indisponible : provisionnement impossible."), { status: 500 });
    }
  }

  if (action === "revoquer") {
    if (!uid) {
      return NextResponse.json({ error: "Champ « uid » requis pour révoquer un client genAPI." }, { status: 400 });
    }
    try {
      const ok = await revoquerClient(uid);
      return NextResponse.json({ ok }, { status: 200 });
    } catch (error) {
      return NextResponse.json(errorBody(error, "genAPI indisponible : révocation impossible."), { status: 500 });
    }
  }

  return NextResponse.json(
    { error: "Action inconnue : « provisionner » ou « revoquer » attendue." },
    { status: 400 },
  );
}
