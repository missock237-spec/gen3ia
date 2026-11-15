import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { assertCanCreateProject } from "@/lib/training/quotas";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import { createProject, listProjects } from "@/lib/training/repository";
import { trainingFamilySchema, trainingModeSchema } from "@/lib/training/types";

/** GET /api/training/projects — liste les projets d'entraînement de l'utilisateur. */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const projects = await listProjects(user.uid);
    return NextResponse.json({ projects, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Liste des projets d'entraînement indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional().default(""),
  family: trainingFamilySchema,
  objective: z.string().max(2000).optional().default(""),
  primaryLanguage: z.string().max(40).optional().default("fr"),
  dataTypes: z.array(z.string().max(40)).max(10).optional().default([]),
  mode: trainingModeSchema.optional().default("assisted"),
});

/** POST /api/training/projects — crée un projet d'entraînement (quota vérifié). */
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Champs du projet invalides : nom (1-120), famille et mode sont requis.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    await assertCanCreateProject(user.uid);
    const project = await createProject(user.uid, {
      name: parsed.data.name,
      description: parsed.data.description,
      family: parsed.data.family,
      objective: parsed.data.objective,
      primaryLanguage: parsed.data.primaryLanguage,
      dataTypes: parsed.data.dataTypes,
      mode: parsed.data.mode,
    });
    void recordTrainingAudit({
      uid: user.uid,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      ip: ipFromRequest(request),
      details: { family: project.family, mode: project.mode },
    }).catch(() => undefined);
    return NextResponse.json({ project, requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    // Audit même des échecs de quota : traçabilité des tentatives.
    if (error instanceof Error && error.message.startsWith("Quota atteint")) {
      try {
        const user = await requireUser(request);
        void recordTrainingAudit({
          uid: user.uid,
          action: "project.created",
          entityType: "project",
          entityId: "-",
          ip: ipFromRequest(request),
          details: { refused: true, reason: "quota-projects" },
        }).catch(() => undefined);
      } catch {
        // Auth déjà validée plus haut : ignore.
      }
    }
    return NextResponse.json(
      { ...errorBody(error, "Création du projet impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}
