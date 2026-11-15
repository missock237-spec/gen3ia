import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import {
  createWorkflow,
  listWorkflows,
  updateWorkflow,
  deleteWorkflow,
  runWorkflow,
  listRuns,
  listNotifications,
} from "@/lib/engines/workflow-engine";
import { BUSINESS_EVENT_TYPES } from "@/lib/engines/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Module ⚡ Automatisations — hub du Workflow Engine.
 * Création de workflows (déclencheur manuel/événement + conditions + étapes),
 * exécution manuelle, activation, journal des runs et notifications in-app
 * produites par les étapes.
 */

const StepConfigSchema = z.record(z.string(), z.unknown());

const StepSchema = z.object({
  id: z.string().min(1).max(60).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["ai_text", "create_event", "create_record", "update_record", "notification"]),
  config: StepConfigSchema,
});

const CreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1_000).optional(),
  trigger: z.object({
    type: z.enum(["manual", "event"]),
    eventType: z.enum(BUSINESS_EVENT_TYPES).optional(),
  }),
  conditions: z
    .array(
      z.object({
        field: z.string().min(1).max(120),
        op: z.enum(["eq", "neq", "gt", "lt", "gte", "lte", "contains"]),
        value: z.union([z.string().max(500), z.number(), z.boolean()]),
      }),
    )
    .max(10)
    .default([]),
  steps: z.array(StepSchema).min(1).max(12),
});

const RunSchema = z.object({
  action: z.literal("run"),
  workflowId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const PatchSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

const BodySchema = z.discriminatedUnion("action", [CreateSchema, RunSchema]);

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:automations:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const [workflows, runs, notifications] = await Promise.all([
      listWorkflows(user.uid),
      listRuns(user.uid, undefined, 40),
      listNotifications(user.uid, 20),
    ]);
    return NextResponse.json({
      workflows,
      runs,
      notifications,
      eventTypes: BUSINESS_EVENT_TYPES,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Automatisations indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });

    if (parsed.data.action === "create") {
      if (parsed.data.trigger.type === "event" && !parsed.data.trigger.eventType) {
        return NextResponse.json({ error: "Choisissez le type d'événement pour un déclencheur événementiel." }, { status: 400 });
      }
      const workflow = await createWorkflow(user.uid, {
        name: parsed.data.name,
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        enabled: true,
        trigger: parsed.data.trigger,
        conditions: parsed.data.conditions,
        steps: parsed.data.steps,
      });
      return NextResponse.json({ workflow }, { status: 201 });
    }

    // action === "run" (exécution manuelle, jusqu'à 5 min pour les chaînes IA)
    const run = await runWorkflow({
      userId: user.uid,
      workflowId: parsed.data.workflowId,
      trigger: "manual",
      payload: parsed.data.payload ?? {},
    });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Action automatisation impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    const workflow = await updateWorkflow(user.uid, parsed.data.id, { enabled: parsed.data.enabled });
    return NextResponse.json({ workflow });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Mise à jour impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteWorkflow(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Automatisation introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
