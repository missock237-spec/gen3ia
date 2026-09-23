import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/security — journal d'audit des outils (admin uniquement).
 * Sources : toolAuditLogs (exécutions d'outils des agents) + demandes
 * d'accès caméra agent. Les entrées sont tronquées : aucune charge utile
 * complète n'est exposée dans la console d'administration.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const { adminDb } = await import("@/lib/firebase/admin");

  const audit: Array<Record<string, unknown>> = [];
  try {
    const snapshot = await adminDb.collection("toolAuditLogs").limit(80).get();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      audit.push({
        id: doc.id,
        userId: typeof data.userId === "string" ? data.userId : null,
        toolId: typeof data.toolId === "string" ? data.toolId : null,
        status: data.result?.status ?? null,
        executionId: typeof data.executionId === "string" ? data.executionId : null,
        createdAt: data.createdAt ?? null,
      });
    }
  } catch {
    /* liste vide en cas de panne */
  }

  const camera: Array<Record<string, unknown>> = [];
  try {
    const snapshot = await adminDb.collection("agentCameraRequests").limit(20).get();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      camera.push({
        id: doc.id,
        userId: typeof data.userId === "string" ? data.userId : null,
        status: typeof data.status === "string" ? data.status : null,
        createdAt: data.createdAt ?? null,
      });
    }
  } catch {
    /* idem */
  }

  const counts = { total: audit.length, cameraRequests: camera.length };
  return NextResponse.json(
    { audit, cameraRequests: camera, counts, generatedAt: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}
