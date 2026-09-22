import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { nextMaintenanceDue, maintenanceStatus, createEvent } from "@/lib/engines/scheduling-engine";
import { proofDocument } from "@/lib/engines/document-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Module Opérations — Maintenance.
 * Actifs équipés d'un plan de maintenance préventive (intervalle en jours) :
 * prochaine échéance calculée par le Scheduling Engine, statut dérivé
 * (à jour / échéance proche / en retard), enregistrement d'intervention avec
 * preuve horodatée PDF et replanification automatique.
 */

const COLLECTION = "maintenanceAssets";

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  location: z.string().trim().max(160).optional(),
  intervalDays: z.number().int().min(1).max(3_650),
  lastDoneAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().trim().max(1_000).optional(),
});

const RecordSchema = z.object({
  action: z.literal("record"),
  assetId: z.string().min(1),
  performedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  technician: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1_000).optional(),
  cost: z.number().min(0).max(1_000_000).optional(),
});

const BodySchema = z.discriminatedUnion("action", [CreateSchema.extend({ action: z.literal("create") }), RecordSchema]);

export interface AssetData {
  name: string;
  location?: string;
  intervalDays: number;
  lastDoneAt?: string;
  nextDueAt?: string;
  notes?: string;
  maintenanceCount: number;
}

/** Enrichit un actif avec statut dérivé (affichage). */
function withDerived(asset: Record<string, unknown>) {
  const nextDueAt = (asset as { nextDueAt?: string }).nextDueAt;
  return {
    ...asset,
    status: nextDueAt ? maintenanceStatus(nextDueAt) : "ok",
    daysUntilDue: nextDueAt ? Math.ceil((new Date(nextDueAt).getTime() - Date.now()) / (24 * 3600 * 1000)) : null,
  };
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:maintenance:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 120 });
    const assets = records.map(unfoldRecord).map(withDerived);
    return NextResponse.json({
      assets,
      kpis: {
        total: assets.length,
        overdue: assets.filter((a) => (a as { status?: string }).status === "overdue").length,
        dueSoon: assets.filter((a) => (a as { status?: string }).status === "due_soon").length,
      },
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Actifs indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const body = parsed.data;

    if (body.action === "create") {
      const lastDoneAt = body.lastDoneAt ? `${body.lastDoneAt}T09:00:00.000Z` : new Date().toISOString();
      const nextDueAt = nextMaintenanceDue(lastDoneAt, body.intervalDays);
      const record = await createRecord({
        userId: user.uid,
        collection: COLLECTION,
        data: {
          name: body.name,
          ...(body.location ? { location: body.location } : {}),
          intervalDays: body.intervalDays,
          lastDoneAt,
          nextDueAt,
          ...(body.notes ? { notes: body.notes } : {}),
          maintenanceCount: 0,
        } satisfies AssetData as unknown as Record<string, unknown>,
      });

      // Rappel planifié 3 jours avant l'échéance (Scheduling Engine).
      const reminder = new Date(nextDueAt);
      reminder.setUTCDate(reminder.getUTCDate() - 3);
      if (reminder.getTime() > Date.now()) {
        await createEvent({
          userId: user.uid,
          type: "maintenance",
          title: `Maintenance à préparer — ${body.name}`,
          description: `Échéance du plan préventif (tous les ${body.intervalDays} jours).`,
          startAt: reminder.toISOString(),
          related: { module: "operations", refId: record.id },
        });
      }
      return NextResponse.json({ asset: withDerived(unfoldRecord(record)) }, { status: 201 });
    }

    // action === "record" : intervention réalisée → replanification + preuve.
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 200 });
    const record = records.find((r) => r.id === body.assetId);
    if (!record) return NextResponse.json({ error: "Actif introuvable." }, { status: 404 });
    const data = record.data as unknown as AssetData;

    const performedAt = `${body.performedAt ?? new Date().toISOString().slice(0, 10)}T10:00:00.000Z`;
    const nextDueAt = nextMaintenanceDue(performedAt, data.intervalDays);
    const updated = await updateRecord(COLLECTION, user.uid, record.id, {
      lastDoneAt: performedAt,
      nextDueAt,
      maintenanceCount: (data.maintenanceCount ?? 0) + 1,
      ...(body.notes ? { notes: body.notes } : {}),
    });

    await proofDocument({
      userId: user.uid,
      feature: "operations-maintenance",
      title: `Preuve de maintenance — ${data.name}`,
      facts: [
        { label: "Actif", value: data.name },
        { label: "Localisation", value: data.location ?? "—" },
        { label: "Intervenant", value: body.technician ?? "Non renseigné" },
        { label: "Date d'intervention", value: performedAt },
        ...(body.cost !== undefined ? [{ label: "Coût", value: `${body.cost} EUR` }] : []),
        { label: "Prochaine échéance", value: nextDueAt },
      ],
      notes: body.notes,
    });

    await emitBusinessEvent({
      userId: user.uid,
      eventType: "operations.maintenance_recorded",
      payload: { assetId: record.id, assetName: data.name, performedAt, nextDueAt },
    }).catch(() => undefined);

    return NextResponse.json({ asset: withDerived(unfoldRecord(updated)) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Enregistrement impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteRecord(COLLECTION, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Actif introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
