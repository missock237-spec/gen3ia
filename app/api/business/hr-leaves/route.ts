import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { leaveBusinessDays, createEvent } from "@/lib/engines/scheduling-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Module RH — Congés.
 * Demandes de congé avec calcul de jours ouvrés (Scheduling Engine), soldes
 * par employé, décision (approbation/refus) qui crée automatiquement
 * l'événement de calendrier et notifie les automatisations.
 */

const COLLECTION = "hrLeaves";
export const DEFAULT_ANNUAL_ALLOWANCE_DAYS = 25;

const LeaveTypeSchema = z.enum(["paid", "sick", "unpaid", "remote"]);
const StatusSchema = z.enum(["pending", "approved", "rejected"]);

const CreateSchema = z.object({
  employeeName: z.string().trim().min(2).max(120),
  type: LeaveTypeSchema.default("paid"),
  startAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue : AAAA-MM-JJ"),
  endAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue : AAAA-MM-JJ"),
  reason: z.string().trim().max(500).optional(),
  allowanceOverride: z.number().int().min(0).max(365).optional(),
});

const DecideSchema = z.object({ id: z.string().min(1), status: z.enum(["approved", "rejected"]) });

export interface LeaveData {
  employeeName: string;
  type: z.infer<typeof LeaveTypeSchema>;
  startAt: string;
  endAt: string;
  reason?: string;
  days: number;
  allowance: number;
  status: z.infer<typeof StatusSchema>;
  decidedAt?: string;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:hr-leaves:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 120 });
    const leaves = records.map(unfoldRecord) as Array<Record<string, unknown> & LeaveData>;
    // Solde restant par employé : alloué − congés payés approuvés de l'année en cours.
    const year = new Date().getUTCFullYear();
    const balances: Record<string, { allowance: number; taken: number; remaining: number }> = {};
    for (const leave of leaves) {
      const name = String(leave.employeeName ?? "—");
      const entry = (balances[name] ??= { allowance: Number(leave.allowance ?? DEFAULT_ANNUAL_ALLOWANCE_DAYS), taken: 0, remaining: 0 });
      if (leave.status === "approved" && leave.type === "paid" && String(leave.startAt ?? "").startsWith(String(year))) {
        entry.taken += Number(leave.days ?? 0);
      }
    }
    for (const entry of Object.values(balances)) entry.remaining = Math.round((entry.allowance - entry.taken) * 10) / 10;
    return NextResponse.json({ leaves, balances });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Congés indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = CreateSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const { startAt, endAt } = parsed.data;
    if (endAt < startAt) return NextResponse.json({ error: "La date de fin précède la date de début." }, { status: 400 });

    const days = leaveBusinessDays(startAt, endAt);
    const record = await createRecord({
      userId: user.uid,
      collection: COLLECTION,
      data: {
        employeeName: parsed.data.employeeName,
        type: parsed.data.type,
        startAt,
        endAt,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        days,
        allowance: parsed.data.allowanceOverride ?? DEFAULT_ANNUAL_ALLOWANCE_DAYS,
        status: "pending",
      } satisfies LeaveData as unknown as Record<string, unknown>,
    });

    await emitBusinessEvent({
      userId: user.uid,
      eventType: "hr.leave_requested",
      payload: { leaveId: record.id, employeeName: parsed.data.employeeName, days, type: parsed.data.type, startAt, endAt },
    }).catch(() => undefined);

    return NextResponse.json({ leave: unfoldRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création de la demande impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = DecideSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 200 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Demande introuvable." }, { status: 404 });
    const data = record.data as unknown as LeaveData;
    if (data.status !== "pending") return NextResponse.json({ error: "Cette demande a déjà été traitée." }, { status: 409 });

    const updated = await updateRecord(COLLECTION, user.uid, record.id, {
      status: parsed.data.status,
      decidedAt: new Date().toISOString(),
    });

    // Approbation → événement de calendrier "leave" (Scheduling Engine).
    if (parsed.data.status === "approved") {
      await createEvent({
        userId: user.uid,
        type: "leave",
        title: `Congé — ${data.employeeName}`,
        description: `Congé ${data.type} approuvé (${data.days} jours ouvrés)${data.reason ? ` — ${data.reason}` : ""}`,
        startAt: `${data.startAt}T09:00:00.000Z`,
        endAt: `${data.endAt}T18:00:00.000Z`,
        allDay: true,
        related: { module: "hr", refId: record.id },
      });
    }

    await emitBusinessEvent({
      userId: user.uid,
      eventType: "hr.leave_decided",
      payload: { leaveId: record.id, employeeName: data.employeeName, status: parsed.data.status, days: data.days },
    }).catch(() => undefined);

    return NextResponse.json({ leave: unfoldRecord(updated) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Décision impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteRecord(COLLECTION, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Demande introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
