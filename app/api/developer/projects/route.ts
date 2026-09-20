import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { createDeveloperProject, listDeveloperProjects } from "@/lib/developer/projects";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    return NextResponse.json({ projects: await listDeveloperProjects(token.uid) });
  } catch (error) { return extensionApiError(error); }
}

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const project = await createDeveloperProject(token.uid, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : "",
      framework: typeof body.framework === "string" ? body.framework : "nextjs",
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) { return extensionApiError(error); }
}
