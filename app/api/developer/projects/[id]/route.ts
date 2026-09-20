import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { getDeveloperProject, updateDeveloperProject } from "@/lib/developer/projects";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const project = await getDeveloperProject(token.uid, id);
    if (!project) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) { return extensionApiError(error); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const project = await updateDeveloperProject(token.uid, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      framework: typeof body.framework === "string" ? body.framework : undefined,
      environment: typeof body.environment === "string" ? body.environment as "development" | "preview" | "production" : undefined,
      status: typeof body.status === "string" ? body.status as "active" | "archived" : undefined,
    });
    return NextResponse.json({ project });
  } catch (error) { return extensionApiError(error); }
}
