import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { createProject, listProjects } from "@/lib/domain/projects/repository";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(600).optional(),
  instructions: z.string().trim().max(8000).optional(),
  authorizedConnectors: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
  privacyRules: z.string().trim().max(2000).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limitRaw = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
    return NextResponse.json({ projects: await listProjects(user.uid, limit) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Impossible de charger les projets."), { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = CreateSchema.parse(await request.json());
    const project = await createProject(user.uid, body);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création du projet impossible."), { status: errorStatus(error, 400) });
  }
}
