import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { validateSimpleRecord } from "@/lib/extensions/schema-validate";
import { executeExtensionTool, extensionToolName, runExtensionWorkflow } from "@/lib/extensions/runtime";
import { getExtension, getInstallation, getLatestApprovedVersion } from "@/lib/extensions/repository";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/extensions/:id/run — execute a tool or a workflow of an installed
 * extension for the authenticated user (manual runs, outside agent flows).
 * Body: { toolId?, input? } or { workflowId?, input? }
 * The execution goes through the exact same Extension Runtime pipeline as
 * agent-driven calls (entitlement, quotas, rate limit, permissions, sandbox).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      toolId?: unknown;
      workflowId?: unknown;
      input?: unknown;
    };
    const input = (typeof body.input === "object" && body.input !== null ? body.input : {}) as Record<string, unknown>;

    const installation = await getInstallation(id, token.uid);
    if (!installation || installation.status !== "active") {
      return NextResponse.json({ error: "Cette extension n'est pas installée." }, { status: 400 });
    }
    const version = await getLatestApprovedVersion(id);
    if (!version) return NextResponse.json({ error: "Aucune version approuvée." }, { status: 400 });
    void (await getExtension(id));

    if (typeof body.workflowId === "string" && body.workflowId) {
      const workflow = (version.manifest.workflows ?? []).find((item) => item.id === body.workflowId);
      if (!workflow) return NextResponse.json({ error: "Workflow introuvable dans cette extension." }, { status: 404 });
      const inputErrors = validateSimpleRecord(input, workflow.inputSchema, "input");
      if (inputErrors.length > 0) {
        return NextResponse.json({ error: "Entrée invalide.", details: inputErrors }, { status: 400 });
      }
      const outputs = await runExtensionWorkflow({
        userId: token.uid,
        extensionId: id,
        workflowId: workflow.id,
        input,
        signal: request.signal,
      });
      return NextResponse.json({ kind: "workflow", workflowId: workflow.id, outputs });
    }

    if (typeof body.toolId === "string" && body.toolId) {
      const tool = (version.manifest.tools ?? []).find((item) => item.id === body.toolId);
      if (!tool) return NextResponse.json({ error: "Tool introuvable dans cette extension." }, { status: 404 });
      const inputErrors = validateSimpleRecord(input, tool.inputSchema, "input");
      if (inputErrors.length > 0) {
        return NextResponse.json({ error: "Entrée invalide.", details: inputErrors }, { status: 400 });
      }
      const output = await executeExtensionTool({
        userId: token.uid,
        toolName: extensionToolName(id, tool.id),
        input,
        signal: request.signal,
      });
      return NextResponse.json({ kind: "tool", toolId: tool.id, output });
    }

    return NextResponse.json({ error: "Indiquez toolId ou workflowId." }, { status: 400 });
  } catch (error) {
    return extensionApiError(error);
  }
}
