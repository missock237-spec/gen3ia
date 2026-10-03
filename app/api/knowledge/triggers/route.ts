import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { createKnowledgeTrigger, listKnowledgeTriggers } from "@/lib/knowledge/triggers";

/**
 * DÉCLENCHEURS D'INGESTION (concept post-SaaS #9) — collection.
 * GET  : liste des déclencheurs du propriétaire.
 * POST : création (agent cible validé : réel, actif, accessible).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const triggers = await listKnowledgeTriggers(user.uid);
    return NextResponse.json({ triggers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Déclencheurs indisponibles" },
      { status: errorStatus(error, 500) },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const trigger = await createKnowledgeTrigger(user.uid, await request.json());
    return NextResponse.json({ trigger }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Création impossible";
    return NextResponse.json({ error: message }, { status: errorStatus(error, message.includes("introuvable") ? 422 : 400) });
  }
}
