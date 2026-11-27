/**
 * API PP — enrôlement d'un pair (Phase 1 du plan PP : bootstrap trust).
 *
 * POST /api/pp/enroll — PUBLIC mais encadré : le corps doit porter un jeton
 * d'invitation à USAGE UNIQUE émis par l'administrateur (tableau de bord),
 * jamais exposé dans le code source. Le pair est enregistré « en_attente » ;
 * il ne devient « actif » qu'après approbation explicite (POST /api/pp/registry
 * action=approve). Aucun secret ne transite ici : uniquement des clés PUBLIQUES.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getTrustRegistry } from "@/lib/pp/server/signaling-store";

const EnrollSchema = z.object({
  appId: z.string().min(1).max(128),
  peerId: z.string().regex(/^[0-9a-f]{64}$/),
  hardwarePubKey: z.string().regex(/^[0-9a-f]{64,177}$/),
  hardwareAlgo: z.enum(["ed25519", "ecdsa-p256"]),
  transportStaticPub: z.string().regex(/^[0-9a-f]{64}$/),
  invitationToken: z.string().min(32).max(128),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = EnrollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "requete-invalide", message: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") } }, { status: 400 });
  }
  const registry = getTrustRegistry();
  await registry.init();
  try {
    const record = await registry.enroll(parsed.data.appId, parsed.data.peerId, parsed.data.hardwarePubKey, parsed.data.hardwareAlgo, parsed.data.transportStaticPub, parsed.data.invitationToken);
    return NextResponse.json({ status: record.status, peerId: record.peerId, message: "pair enregistré en attente d'approbation administrateur" }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { code: "enrolement-refuse", message: error instanceof Error ? error.message : String(error) } }, { status: 403 });
  }
}
