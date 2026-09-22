import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { createEvent } from "@/lib/engines/scheduling-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Module Conformité — RGPD.
 * 1) Registre des traitements : finalité, base légale, catégories de
 *    données, destinataires, durée de conservation, sécurisation.
 * 2) Demandes des personnes concernées (DSR) : accès, rectification,
 *    effacement, portabilité — avec échéance réglementaire (30 jours)
 *    synchronisée dans le Scheduling Engine.
 */

const PROCESSING_COLLECTION = "gdprProcessingRecords";
const REQUESTS_COLLECTION = "gdprRequests";

export const DSR_SLA_DAYS = 30;

const LegalBasisSchema = z.enum(["consent", "contract", "legal_obligation", "legitimate_interest", "vital_interest", "public_task"]);

const ProcessingSchema = z.object({
  kind: z.literal("processing"),
  processingName: z.string().trim().min(2).max(160),
  purpose: z.string().trim().min(5).max(600),
  legalBasis: LegalBasisSchema,
  dataCategories: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  recipients: z.string().trim().max(400).optional(),
  retentionDays: z.number().int().min(1).max(36_500),
  secured: z.boolean().default(true),
});

const RequestTypeSchema = z.enum(["access", "rectification", "erasure", "portability", "opposition"]);

const RequestSchema = z.object({
  kind: z.literal("request"),
  subjectName: z.string().trim().min(2).max(120),
  subjectEmail: z.string().trim().email().max(160),
  type: RequestTypeSchema,
  details: z.string().trim().max(1_000).optional(),
});

const PostSchema = z.discriminatedUnion("kind", [ProcessingSchema, RequestSchema]);

const PatchSchema = z.object({
  kind: z.enum(["processing", "request"]),
  id: z.string().min(1),
  status: z.enum(["received", "in_progress", "fulfilled", "refused"]).optional(),
  notes: z.string().max(1_000).optional(),
});

const REQUEST_TYPE_LABELS: Record<z.infer<typeof RequestTypeSchema>, string> = {
  access: "Droit d'accès",
  rectification: "Rectification",
  erasure: "Effacement",
  portability: "Portabilité",
  opposition: "Opposition",
};

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:gdpr:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const [processing, requests] = await Promise.all([
      listRecords({ userId: user.uid, collection: PROCESSING_COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 80 }),
      listRecords({ userId: user.uid, collection: REQUESTS_COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 80 }),
    ]);

    const now = Date.now();
    const requestsWithSla = requests.map(unfoldRecord).map((r): Record<string, unknown> => {
      const entry = r as { deadlineAt?: string; status?: string };
      const deadlineAt = String(entry.deadlineAt ?? "");
      const status = String(entry.status ?? "received");
      const daysLeft = deadlineAt ? Math.ceil((new Date(deadlineAt).getTime() - now) / (24 * 3600 * 1000)) : null;
      const sla = status === "fulfilled" || status === "refused" ? "closed" : daysLeft !== null && daysLeft < 0 ? "breached" : daysLeft !== null && daysLeft <= 7 ? "urgent" : "ok";
      return { ...r, daysLeft, sla };
    });

    return NextResponse.json({
      processing: processing.map(unfoldRecord),
      requests: requestsWithSla,
      kpis: {
        openRequests: requestsWithSla.filter((r) => !["fulfilled", "refused"].includes(String((r as { status?: string }).status))).length,
        breached: requestsWithSla.filter((r) => r.sla === "breached").length,
      },
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Registre RGPD indisponible."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PostSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });

    if (parsed.data.kind === "processing") {
      const record = await createRecord({
        userId: user.uid,
        collection: PROCESSING_COLLECTION,
        data: {
          processingName: parsed.data.processingName,
          purpose: parsed.data.purpose,
          legalBasis: parsed.data.legalBasis,
          dataCategories: parsed.data.dataCategories,
          ...(parsed.data.recipients ? { recipients: parsed.data.recipients } : {}),
          retentionDays: parsed.data.retentionDays,
          secured: parsed.data.secured,
        },
      });
      return NextResponse.json({ processing: unfoldRecord(record) }, { status: 201 });
    }

    // Demande DSR : calcul de l'échéance réglementaire + rappel calendrier.
    const receivedAt = new Date();
    const deadlineAt = new Date(receivedAt);
    deadlineAt.setUTCDate(deadlineAt.getUTCDate() + DSR_SLA_DAYS);

    const record = await createRecord({
      userId: user.uid,
      collection: REQUESTS_COLLECTION,
      data: {
        subjectName: parsed.data.subjectName,
        subjectEmail: parsed.data.subjectEmail,
        type: parsed.data.type,
        typeLabel: REQUEST_TYPE_LABELS[parsed.data.type],
        ...(parsed.data.details ? { details: parsed.data.details } : {}),
        receivedAt: receivedAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        status: "received",
      },
    });

    await createEvent({
      userId: user.uid,
      type: "deadline",
      title: `RGPD — ${REQUEST_TYPE_LABELS[parsed.data.type]} : ${parsed.data.subjectName}`,
      description: `Échéance réglementaire (${DSR_SLA_DAYS} jours) pour la demande de ${parsed.data.subjectEmail}.`,
      startAt: deadlineAt.toISOString(),
      related: { module: "compliance", refId: record.id },
    });

    void emitBusinessEvent({
      userId: user.uid,
      eventType: "gdpr.request_received",
      payload: { requestId: record.id, type: parsed.data.type, subjectName: parsed.data.subjectName, deadlineAt: deadlineAt.toISOString() },
    }).catch(() => undefined);

    return NextResponse.json({ request: unfoldRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Enregistrement impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    const collection = parsed.data.kind === "processing" ? PROCESSING_COLLECTION : REQUESTS_COLLECTION;

    const records = await listRecords({ userId: user.uid, collection, fresh: true, limit: 200 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Entrée introuvable." }, { status: 404 });

    const updated = await updateRecord(collection, user.uid, record.id, {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.status === "fulfilled" ? { fulfilledAt: new Date().toISOString() } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    });

    if (parsed.data.kind === "request" && parsed.data.status === "fulfilled") {
      void emitBusinessEvent({
        userId: user.uid,
        eventType: "gdpr.request_fulfilled",
        payload: { requestId: record.id, subjectName: String((record.data as { subjectName?: string }).subjectName ?? "") },
      }).catch(() => undefined);
    }

    return NextResponse.json({ entry: unfoldRecord(updated) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Mise à jour impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    const kind = request.nextUrl.searchParams.get("kind");
    if (!id || !kind) return NextResponse.json({ error: "Paramètres id et kind requis." }, { status: 400 });
    const collection = kind === "processing" ? PROCESSING_COLLECTION : REQUESTS_COLLECTION;
    const deleted = await deleteRecord(collection, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Entrée introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
