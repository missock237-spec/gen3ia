import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { protectRoute } from "@/lib/security/route-guard";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { recordAuditEventSafe } from "@/lib/security/audit-events";
import {
  API_KEY_SCOPES,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/security/api-keys";

/**
 * GESTION SELF-SERVICE DES CLÉS API ENTREPRISE (Task 126).
 *
 *   GET    /api/settings/api-keys — liste (préfixe, scopes, dates — jamais la clé)
 *   POST   /api/settings/api-keys — création : la clé complète n'est renvoyée
 *          qu'ICI, UNE seule fois
 *   DELETE /api/settings/api-keys — révocation soft par identifiant
 *
 * Toutes les opérations sont authentifiées session Firebase (protectRoute),
 * rate-limitées, et journalisées dans `auditEvents`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
});

const RevokeSchema = z.object({ id: z.string().trim().min(1).max(128) });

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "settings-api-keys-list" });
  if (!guard.ok) return guard.response;
  try {
    const keys = await listApiKeys(guard.context.userId);
    return NextResponse.json({ keys }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Liste des clés API indisponible."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  // Création plus sévèrement bornée que la lecture : 10 créations/heure.
  const guard = await protectRoute(request, {
    key: "settings-api-keys-create",
    rateLimit: { limit: 10, windowMs: 60 * 60 * 1000 },
  });
  if (!guard.ok) return guard.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Requête invalide (name 1-100 caractères, scopes non vides).", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const issued = await createApiKey({
      ownerId: guard.context.userId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      rateLimitPerMinute: parsed.data.rateLimitPerMinute,
    });
    recordAuditEventSafe({
      actorId: guard.context.userId,
      actorEmail: guard.context.email ?? null,
      action: "apikey.create",
      outcome: "granted",
      targetType: "api_key",
      targetId: issued.view.prefix,
      metadata: { scopes: issued.view.scopes, rateLimitPerMinute: issued.view.rateLimitPerMinute },
    });
    return NextResponse.json(
      {
        key: issued.key,
        view: issued.view,
        warning: "Conservez cette clé maintenant : elle ne sera plus jamais affichée.",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création de clé API impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request, {
    key: "settings-api-keys-revoke",
    rateLimit: { limit: 30, windowMs: 60 * 60 * 1000 },
  });
  if (!guard.ok) return guard.response;

  const parsed = RevokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Identifiant de clé requis." }, { status: 400 });
  }

  try {
    const view = await revokeApiKey(guard.context.userId, parsed.data.id);
    recordAuditEventSafe({
      actorId: guard.context.userId,
      actorEmail: guard.context.email ?? null,
      action: "apikey.revoke",
      outcome: "completed",
      targetType: "api_key",
      targetId: view.prefix,
    });
    return NextResponse.json({ view }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Révocation impossible."), { status: errorStatus(error) });
  }
}
