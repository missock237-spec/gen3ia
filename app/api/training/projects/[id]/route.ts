import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { deleteProject, getProjectOverview, updateProject } from "@/lib/training/repository";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import { sweepUserJobs } from "@/lib/training/orchestrator";
import { trainingModeSchema } from "@/lib/training/types";

/** GET /api/training/projects/[id] — vue agrégée (projet + assets + plans + jobs + exports). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    // Sweep opportuniste : rafraîchit les jobs actifs avant de répondre.
    await sweepUserJobs(user.uid).catch(() => undefined);
    const overview = await getProjectOverview(user.uid, id);
    if (!overview) {
      return NextResponse.json(
        { error: "Projet introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json({ ...overview, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Projet indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

const patchProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  objective: z.string().max(2000).optional(),
  primaryLanguage: z.string().max(40).optional(),
  dataTypes: z.array(z.string().max(40)).max(10).optional(),
  mode: trainingModeSchema.optional(),
  status: z.enum(["active", "archived"]).optional(),
});

/** PATCH /api/training/projects/[id] — met à jour les champs éditables. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = patchProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Champs de mise à jour invalides.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const updated = await updateProject(user.uid, id, parsed.data);
    if (!updated) {
      return NextResponse.json(
        { error: "Projet introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    void recordTrainingAudit({
      uid: user.uid,
      action: updated.status === "archived" ? "project.archived" : "project.updated",
      entityType: "project",
      entityId: updated.id,
      ip: ipFromRequest(request),
      details: { champs: Object.keys(parsed.data).slice(0, 8) },
    }).catch(() => undefined);
    return NextResponse.json({ project: updated, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Mise à jour impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}

/** DELETE /api/training/projects/[id] — supprime le projet et tout son contenu. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const removed = await deleteProject(user.uid, id);
    if (!removed) {
      return NextResponse.json(
        { error: "Projet introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    void recordTrainingAudit({
      uid: user.uid,
      action: "project.deleted",
      entityType: "project",
      entityId: id,
      ip: ipFromRequest(request),
    }).catch(() => undefined);
    return NextResponse.json({ removed: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Suppression impossible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
