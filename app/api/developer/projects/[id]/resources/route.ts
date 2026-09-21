import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { assertDeveloperRole } from "@/lib/access/platform";
import { extensionApiError } from "@/lib/extensions/api";
import { getDeveloperProjectResourceSummary } from "@/lib/extensions/repository";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = await verifyFirebaseAuth(request);
    await assertDeveloperRole(token.uid);
    const { id } = await params;
    const summary = await getDeveloperProjectResourceSummary(token.uid, id);
    return NextResponse.json({
      projectId: id,
      resources: [
        { id: "api", label: "APIs & routes", href: "/developer?project=" + encodeURIComponent(id) + "&tab=build", status: "available" },
        { id: "tools", label: "Tools", href: "/developer?project=" + encodeURIComponent(id) + "&tab=build", status: "available" },
        { id: "connectors", label: "Connecteurs OAuth", href: "/developer?project=" + encodeURIComponent(id) + "&tab=build", status: "available" },
        { id: "webhooks", label: "Webhooks", href: "/developer?project=" + encodeURIComponent(id) + "&tab=build", status: "available" },
        { id: "secrets", label: "Secrets", href: "/developer?project=" + encodeURIComponent(id) + "&tab=build", status: "available" },
        { id: "sandbox", label: "Sandbox", href: "/developer?project=" + encodeURIComponent(id) + "&tab=build", status: "available" },
        { id: "deployments", label: "Deployments", href: "/developer?project=" + encodeURIComponent(id) + "&tab=monitor", status: "available" },
      ],
      authenticated: true,
      summary: summary.resources,
      extensionIds: summary.extensionIds,
    });
  } catch (error) {
    return extensionApiError(error);
  }
}
