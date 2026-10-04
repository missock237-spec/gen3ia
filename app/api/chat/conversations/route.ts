import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { createConversation, listConversations } from "@/lib/chat/repository";
import { errorBody, errorStatus, serviceUnavailable } from "@/lib/security/http-errors";
import { isFirestoreQuotaError } from "@/lib/db/quota-guard";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? 50);
    // Historique scopé à un agent IA (?agentId=…) : l'atelier n'affiche que
    // les conversations de l'agent sélectionné.
    const agentId = params.get("agentId")?.trim() || undefined;
    return NextResponse.json({ conversations: await listConversations(user.uid, Number.isFinite(limit) ? limit : 50, { agentId }) });
  } catch (error) {
    // Persistance indisponible (quota Firestore épuisé) : 503 dégradé — 401
    // reste réservé aux vraies erreurs d'authentification (sinon l'UI prend
    // une panne de base pour une déconnexion).
    const normalized = isFirestoreQuotaError(error) ? serviceUnavailable() : error;
    return NextResponse.json(errorBody(normalized, "Erreur."), { status: errorStatus(normalized, 401) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = z.object({ title: z.string().trim().max(120).optional() }).parse(await request.json().catch(() => ({})));
    return NextResponse.json({ conversation: await createConversation(user.uid, body.title) }, { status: 201 });
  } catch (error) {
    // Même contrat que le GET : la panne de persistance est un 503 dégradé.
    const normalized = isFirestoreQuotaError(error) ? serviceUnavailable() : error;
    return NextResponse.json(errorBody(normalized, "Erreur."), { status: errorStatus(normalized, 400) });
  }
}
