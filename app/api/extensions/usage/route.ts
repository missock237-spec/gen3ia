import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { getExtension, getInstallation, listExtensionExecutions } from "@/lib/extensions/repository";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const url = new URL(request.url);
    const extensionId = url.searchParams.get("extensionId")?.trim();
    if (!extensionId) return NextResponse.json({ error: "extensionId requis." }, { status: 400 });

    const installation = await getInstallation(extensionId, token.uid);
    if (!installation || installation.status !== "active") {
      return NextResponse.json({ error: "Extension non installée." }, { status: 403 });
    }

    const extension = await getExtension(extensionId);
    if (!extension) return NextResponse.json({ error: "Extension introuvable." }, { status: 404 });

    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 50;
    const executions = await listExtensionExecutions({ extensionId, userId: token.uid, limit });

    return NextResponse.json({
      extension: { id: extension.id, name: extension.name },
      installation: { version: installation.version, status: installation.status },
      executions: executions.map((execution) => ({
        id: String(execution.id ?? ""),
        version: String(execution.version ?? ""),
        toolId: String(execution.toolId ?? ""),
        ok: Boolean(execution.ok),
        status: String(execution.status ?? ""),
        durationMs: Number(execution.durationMs ?? 0),
        createdAt: Number(execution.createdAt ?? 0),
        error: execution.ok ? null : String(execution.error ?? "Execution failed"),
      })),
    });
  } catch {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
}
