import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/platform — indicateurs globaux de la plateforme
 * (admin uniquement). Compteurs agrégés Firestore, tolérant aux pannes
 * partielles : chaque mesure est indépendante.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const { adminDb } = await import("@/lib/firebase/admin");

  const countOf = async (collection: string): Promise<number> => {
    try {
      const snapshot = await adminDb.collection(collection).count().get();
      return snapshot.data().count ?? 0;
    } catch {
      return -1;
    }
  };

  const [users, teams, tasks, agents, extensions, installations, executions, memories] = await Promise.all([
    countOf("users"),
    countOf("teams"),
    countOf("agentWorkspaceTasks"),
    countOf("agents"),
    countOf("extensions"),
    countOf("extensionInstallations"),
    countOf("executions"),
    countOf("memories"),
  ]);

  // Missions par statut (lecture ciblée, limitée).
  const statusCounts: Record<string, number> = {};
  try {
    const snapshot = await adminDb.collection("agentWorkspaceTasks").limit(500).get();
    for (const doc of snapshot.docs) {
      const status = String(doc.get("status") ?? "unknown");
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
  } catch {
    /* mesure optionnelle */
  }

  return NextResponse.json(
    {
      metrics: {
        users,
        teams,
        tasks,
        agents,
        extensions,
        installations,
        executions,
        memories,
      },
      taskStatusCounts: statusCounts,
      generatedAt: Date.now(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
