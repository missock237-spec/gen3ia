import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { verifyDeveloperProjectAccess } from "@/lib/extensions/repository";
import { listDeveloperProjectConnectors, upsertDeveloperProjectConnector } from "@/lib/developer/connectors";
import { getComposio } from "@/lib/integrations/composio/client";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;
  try {
    await verifyDeveloperProjectAccess(guard.context.userId, params.id);
    const connectors = await listDeveloperProjectConnectors(guard.context.userId, params.id);
    const accounts = await getComposio().connectedAccounts.list({ userIds: [guard.context.userId] });
    const accountById = new Map(accounts.items.map((a) => [a.id, a]));
    const synced = await Promise.all(connectors.map(async (item) => {
      const account = accountById.get(item.connectionId);
      const status = !account ? "disabled" : String(account.status).toLowerCase() === "active" ? "active" : "pending";
      if (status !== item.status) {
        return upsertDeveloperProjectConnector({
          projectId: item.projectId,
          userId: item.userId,
          toolkit: item.toolkit,
          connectionId: item.connectionId,
        }).then(async (updated) => {
          const { adminDb } = await import("@/lib/firebase/admin");
          await adminDb.collection("developerProjectConnectors").doc(item.id).update({ status, updatedAt: Date.now() });
          return { ...updated, status };
        });
      }
      return item;
    }));
    return NextResponse.json({ connectors: synced });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to sync connectors" }, { status: 400 });
  }
}
