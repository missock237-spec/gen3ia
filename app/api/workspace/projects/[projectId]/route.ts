import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { deleteProject, getProject, updateProject } from "@/lib/domain/projects/repository";

type RouteContext = { params: Promise<{ projectId: string }> };

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(600).optional(),
  instructions: z.string().trim().max(8000).optional(),
  authorizedConnectors: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
  privacyRules: z.string().trim().max(2000).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { projectId } = await params;
    const project = await getProject(user.uid, projectId);
    if (!project) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Projet introuvable."), { status: errorStatus(error, 404) });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { projectId } = await params;
    const body = PatchSchema.parse(await request.json());
    const project = await updateProject(user.uid, projectId, body);
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Mise à jour impossible."), { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { projectId } = await params;
    await deleteProject(user.uid, projectId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error, 404) });
  }
}
