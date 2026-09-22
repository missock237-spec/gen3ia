import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { timeseriesByDay, linearForecast, formatMoney, summarizeNumbers } from "@/lib/engines/analytics-engine";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Module Finance — Cashflow.
 * Flux prévisionnels entrants/sortants, solde projeté à 30/60/90 jours via
 * l'Analytics Engine (tendance linéaire sur les flux nets réalisés + reste à
 * venir planifié), catégorisation simple.
 */

const COLLECTION = "financeCashflowEntries";

const DirectionSchema = z.enum(["in", "out"]);
const EntryStatusSchema = z.enum(["planned", "realized"]);

const CreateSchema = z.object({
  direction: DirectionSchema,
  label: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(60).default("general"),
  amount: z.number().min(0.01).max(100_000_000),
  currency: z.string().length(3).default("EUR"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional(),
});

const PatchSchema = z.object({
  id: z.string().min(1),
  status: EntryStatusSchema.optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z.number().min(0.01).max(100_000_000).optional(),
});

export interface CashflowEntry {
  direction: z.infer<typeof DirectionSchema>;
  label: string;
  category: string;
  amount: number;
  currency: string;
  dueDate: string;
  status: z.infer<typeof EntryStatusSchema>;
  notes?: string;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:cashflow:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 200 });
    const entries = records.map(unfoldRecord) as Array<Record<string, unknown> & CashflowEntry>;
    const currency = String(entries[0]?.currency ?? "EUR");

    // Solde réalisé = somme signée des entrées réalisées à ce jour.
    const nowIsoDay = new Date().toISOString().slice(0, 10);
    let realizedBalance = 0;
    let plannedIn = 0;
    let plannedOut = 0;
    for (const entry of entries) {
      const sign = entry.direction === "in" ? 1 : -1;
      if (entry.status === "realized") realizedBalance += sign * Number(entry.amount ?? 0);
      else if (entry.dueDate >= nowIsoDay) {
        if (entry.direction === "in") plannedIn += Number(entry.amount ?? 0);
        else plannedOut += Number(entry.amount ?? 0);
      }
    }

    // Tendance journalière des flux nets réalisés → projection 30/60/90 j.
    const netSeries = timeseriesByDay(
      entries.filter((e) => e.status === "realized").map((e) => ({ data: e })),
      "data.dueDate",
      "data.amount",
      1,
    );
    // Intègre le signe par direction : refait la somme signée proprement.
    const signed = entries
      .filter((e) => e.status === "realized")
      .map((e) => ({ data: { dueDate: e.dueDate, amount: (e.direction === "in" ? 1 : -1) * Number(e.amount ?? 0) } }));
    const netSignedSeries = timeseriesByDay(signed, "data.dueDate", "data.amount", 1);
    void netSeries;

    const points = netSignedSeries.map((p, index) => ({ x: index, y: p.value }));
    const horizon = 90;
    const trend = linearForecast(points, horizon);
    const projected = (days: number): number => {
      if (points.length === 0) return realizedBalance;
      const trendDelta = trend.predictions.slice(0, days).reduce((acc, v) => acc + v, 0);
      const dueInRange = entries
        .filter((e) => e.status === "planned" && e.dueDate > nowIsoDay && e.dueDate <= new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10))
        .reduce((acc, e) => acc + (e.direction === "in" ? 1 : -1) * Number(e.amount ?? 0), 0);
      return realizedBalance + dueInRange + (trend.slope === 0 ? 0 : Math.round(trendDelta * 100) / 100);
    };

    const monthlyOut = summarizeNumbers(
      entries.filter((e) => e.status === "realized" && e.direction === "out").map((e) => Number(e.amount ?? 0)),
    );

    return NextResponse.json({
      entries,
      kpis: {
        currency,
        realizedBalance: Math.round(realizedBalance * 100) / 100,
        realizedBalanceLabel: formatMoney(realizedBalance, currency),
        plannedIn: Math.round(plannedIn * 100) / 100,
        plannedOut: Math.round(plannedOut * 100) / 100,
        projection30: formatMoney(projected(30), currency),
        projection60: formatMoney(projected(60), currency),
        projection90: formatMoney(projected(90), currency),
        trendSlope: Math.round(trend.slope * 100) / 100,
        r2: Math.round(trend.r2 * 1000) / 1000,
        avgMonthlyOut: Math.round(monthlyOut.avg * 100) / 100,
      },
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Trésorerie indisponible."), { status: errorStatus(error) });
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
        direction: parsed.data.direction,
        label: parsed.data.label,
        category: parsed.data.category,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        dueDate: parsed.data.dueDate,
        status: "planned",
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      } satisfies CashflowEntry as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ entry: unfoldRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 300 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Écriture introuvable." }, { status: 404 });

    const updated = await updateRecord(COLLECTION, user.uid, record.id, {
      ...(parsed.data.status ? { status: parsed.data.status, ...(parsed.data.status === "realized" ? { realizedAt: new Date().toISOString() } : {}) } : {}),
      ...(parsed.data.dueDate ? { dueDate: parsed.data.dueDate } : {}),
      ...(parsed.data.amount !== undefined ? { amount: parsed.data.amount } : {}),
    });
    return NextResponse.json({ entry: unfoldRecord(updated) });
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
    if (!deleted) return NextResponse.json({ error: "Écriture introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
