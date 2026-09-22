import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users — comptes et équipes récents (admin uniquement).
 * Aucune donnée sensible : identifiants publics, rôles, dates, état.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const { adminDb } = await import("@/lib/firebase/admin");

  const users: Array<Record<string, unknown>> = [];
  try {
    const snapshot = await adminDb.collection("users").limit(60).get();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      users.push({
        id: doc.id,
        email: typeof data.email === "string" ? data.email : null,
        displayName: typeof data.displayName === "string" ? data.displayName : null,
        role: typeof data.role === "string" ? data.role : "user",
        plan: typeof data.plan === "string" ? data.plan : null,
        createdAt: data.createdAt ?? null,
        disabled: data.disabled === true,
      });
    }
  } catch {
    /* liste vide en cas de panne — l'échec est signalé côté client si total */
  }

  const teams: Array<Record<string, unknown>> = [];
  try {
    const snapshot = await adminDb.collection("teams").limit(30).get();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      teams.push({
        id: doc.id,
        name: typeof data.name === "string" ? data.name : "Équipe",
        ownerId: typeof data.ownerId === "string" ? data.ownerId : null,
        memberCount: typeof data.memberCount === "number" ? data.memberCount : null,
        createdAt: data.createdAt ?? null,
      });
    }
  } catch {
    /* idem */
  }

  return NextResponse.json(
    { users, teams, generatedAt: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}
