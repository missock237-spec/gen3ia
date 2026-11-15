import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Module RH — Formations.
 * Catalogue de formations par employé avec progression suivie ; l'achèvement
 * (100 %) clôt la formation et déclenche l'événement métier correspondant.
 */

const COLLECTION = "hrTrainings";

const StatusSchema = z.enum(["planned", "in_progress", "completed", "cancelled"]);

const CreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  employeeName: z.string().trim().min(2).max(120),
  category: z.enum(["onboarding", "product", "compliance", "technical", "soft_skills", "management", "other"]).default("other"),
  provider: z.string().trim().max(120).optional(),
  durationHours: z.number().min(0.5).max(500).default(2),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().trim().max(1_000).optional(),
});

const PatchSchema = z.object({
  id: z.string().min(1),
  progress: z.number().int().min(0).max(100).optional(),
  status: StatusSchema.optional(),
});

const COMPLETION_THRESHOLD = 100;

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:hr-training:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 120 });
    const trainings = records.map(unfoldRecord);
    const completed = trainings.filter((t) => (t as { status?: string }).status === "completed").length;
    const inProgress = trainings.filter((t) => (t as { status?: string }).status === "in_progress").length;
    const totalHours = trainings.reduce((acc, t) => acc + Number((t as { durationHours?: number }).durationHours ?? 0), 0);
    return NextResponse.json({ trainings, kpis: { total: trainings.length, completed, inProgress, totalHours: Math.round(totalHours * 10) / 10 } });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Formations indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = CreateSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });

    const record = await createRecord({
      userId: user.uid,
      collection: COLLECTION,
      data: {
        title: parsed.data.title,
        employeeName: parsed.data.employeeName,
        category: parsed.data.category,
        ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
        durationHours: parsed.data.durationHours,
        ...(parsed.data.dueAt ? { dueAt: parsed.data.dueAt } : {}),
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        status: "planned",
        progress: 0,
      },
    });
    return NextResponse.json({ training: unfoldRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 200 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Formation introuvable." }, { status: 404 });
    const data = record.data as { status?: string; progress?: number; title?: string; employeeName?: string; durationHours?: number };

    const nextProgress = parsed.data.progress ?? data.progress ?? 0;
    // Statut dérivé si non fourni : la progression pilote la carte.
    const nextStatus = parsed.data.status ?? (nextProgress >= COMPLETION_THRESHOLD ? "completed" : nextProgress > 0 ? "in_progress" : data.status ?? "planned");
    const wasCompleted = data.status === "completed";

    const updated = await updateRecord(COLLECTION, user.uid, record.id, {
      progress: nextProgress,
      status: nextStatus,
      ...(nextStatus === "completed" ? { completedAt: new Date().toISOString() } : {}),
    });

    if (!wasCompleted && nextStatus === "completed") {
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "hr.training_completed",
        payload: {
          trainingId: record.id,
          title: String(data.title ?? ""),
          employeeName: String(data.employeeName ?? ""),
          durationHours: Number(data.durationHours ?? 0),
        },
      }).catch(() => undefined);
    }

    return NextResponse.json({ training: unfoldRecord(updated) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Mise à jour impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteRecord(COLLECTION, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Formation introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
