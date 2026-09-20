import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { verifyDeveloperProjectAccess } from "@/lib/extensions/repository";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    await verifyDeveloperProjectAccess(token.uid, id);
    const url = new URL(request.url);
    return NextResponse.json({
      projectId: id,
      resources: [
        { id: "api", label: "APIs & routes", href: `/developer?project=${encodeURIComponent(id)}&tab=build`, status: "available" },
        { id: "tools", label: "Tools", href: `/developer?project=${encodeURIComponent(id)}&tab=build`, status: "available" },
        { id: "connectors", label: "Connecteurs OAuth", href: `/developer?project=${encodeURIComponent(id)}&tab=build`, status: "available" },
        { id: "webhooks", label: "Webhooks", href: `/developer?project=${encodeURIComponent(id)}&tab=build`, status: "available" },
        { id: "secrets", label: "Secrets", href: `/developer?project=${encodeURIComponent(id)}&tab=build`, status: "available" },
        { id: "sandbox", label: "Sandbox", href: `/developer?project=${encodeURIComponent(id)}&tab=build`, status: "available" },
        { id: "deployments", label: "Deployments", href: `/developer?project=${encodeURIComponent(id)}&tab=monitor`, status: "available" },
      ],
      authenticated: true,
    });
  } catch (error) {
    return extensionApiError(error);
  }
}
