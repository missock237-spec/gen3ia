import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { runAI } from "@/lib/engines/ai-engine";
import { formatMoney } from "@/lib/engines/analytics-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Module Finance — Impayés.
 * Suivi des factures ouvertes, détection du retard, relances e-mail générées
 * par l'AI Engine à 3 niveaux de fermeté (courtoise / ferme / mise en
 * demeure), statuts mis à jour + événements métier pour les automatisations.
 */

const COLLECTION = "financeInvoices";

const InvoiceStatusSchema = z.enum(["open", "reminded_1", "reminded_2", "escalated", "paid", "written_off"]);

const CreateSchema = z.object({
  action: z.literal("create"),
  invoiceNumber: z.string().trim().min(1).max(40),
  clientName: z.string().trim().min(2).max(160),
  clientEmail: z.string().trim().email().max(160).optional(),
  amount: z.number().min(0.01).max(100_000_000),
  currency: z.string().length(3).default("EUR"),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional(),
});

const RemindSchema = z.object({
  action: z.literal("remind"),
  invoiceId: z.string().min(1),
  level: z.enum(["courtoise", "ferme", "mise_en_demeure"]).default("courtoise"),
  senderName: z.string().trim().max(120).optional(),
});

const PatchSchema = z.object({ id: z.string().min(1), status: z.enum(["open", "paid", "written_off"]) });

const BodySchema = z.discriminatedUnion("action", [CreateSchema, RemindSchema]);

const LEVEL_INSTRUCTIONS: Record<string, string> = {
  courtoise: "Ton courtois et prévenant : rappel amical, hypothèse d'un oubli, facilité de paiement proposée.",
  ferme: "Ton ferme mais professionnel : rappel des échéances, demande de règlement sous 7 jours, mention des pénalités contractuelles.",
  mise_en_demeure: "Ton formel de mise en demeure : sommation de payer sous 7 jours, mention expresse des intérêts de retard et de l'engagement d'une procédure de recouvrement.",
};

function lateDaysOf(dueDate: string): number {
  const due = new Date(`${dueDate}T23:59:59Z`).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((Date.now() - due) / 86_400_000));
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:unpaid:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 200 });
    const invoices = records.map(unfoldRecord).map((invoice) => {
      const data = invoice as { status?: string; dueDate?: string; amount?: number; currency?: string };
      return { ...invoice, lateDays: lateDaysOf(String(data.dueDate ?? "")) };
    });

    const currency = String((invoices[0] as { currency?: string })?.currency ?? "EUR");
    const open = invoices.filter((i) => ["open", "reminded_1", "reminded_2", "escalated"].includes(String((i as { status?: string }).status)));
    const openTotal = open.reduce((acc, i) => acc + Number((i as { amount?: number }).amount ?? 0), 0);
    const late = open.filter((i) => Number((i as { lateDays?: number }).lateDays) > 0);
    const paid = invoices.filter((i) => (i as { status?: string }).status === "paid");
    const recoveryRate = paid.length + open.length > 0 ? Math.round((paid.length / (paid.length + open.length)) * 1000) / 10 : 100;

    return NextResponse.json({
      invoices,
      kpis: {
        currency,
        openCount: open.length,
        openTotalLabel: formatMoney(openTotal, currency),
        lateCount: late.length,
        lateTotalLabel: formatMoney(late.reduce((acc, i) => acc + Number((i as { amount?: number }).amount ?? 0), 0), currency),
        recoveryRate,
      },
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Impayés indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const body = parsed.data;

    if (body.action === "create") {
      const { action: _action, ...fields } = body;
      if (fields.dueDate < fields.issuedAt) return NextResponse.json({ error: "L'échéance précède la date d'émission." }, { status: 400 });
      const record = await createRecord({
        userId: user.uid,
        collection: COLLECTION,
        data: {
          invoiceNumber: fields.invoiceNumber,
          clientName: fields.clientName,
          ...(fields.clientEmail ? { clientEmail: fields.clientEmail } : {}),
          amount: fields.amount,
          currency: fields.currency,
          issuedAt: fields.issuedAt,
          dueDate: fields.dueDate,
          status: "open",
          ...(fields.notes ? { notes: fields.notes } : {}),
          reminders: [],
        },
      });
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "finance.invoice_created",
        payload: { invoiceId: record.id, invoiceNumber: fields.invoiceNumber, amount: fields.amount, currency: fields.currency, dueDate: fields.dueDate },
      }).catch(() => undefined);
      return NextResponse.json({ invoice: unfoldRecord(record) }, { status: 201 });
    }

    // action === "remind" : relance générée par l'AI Engine.
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 300 });
    const record = records.find((r) => r.id === body.invoiceId);
    if (!record) return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
    const data = record.data as {
      invoiceNumber: string;
      clientName: string;
      clientEmail?: string;
      amount: number;
      currency: string;
      issuedAt: string;
      dueDate: string;
      status: string;
      reminders?: Array<{ level: string; sentAt: string; subject: string; body: string }>;
    };
    if (data.status === "paid" || data.status === "written_off") {
      return NextResponse.json({ error: "Cette facture est déjà soldée." }, { status: 409 });
    }

    const lateDays = lateDaysOf(data.dueDate);
    const result = await runAI({
      userId: user.uid,
      feature: "finance-unpaid",
      system:
        "Tu es un gestionnaire de recouvrement expérimenté. Tu rédiges des e-mails de relance d'impayés en français, précis et sans agressivité inutile. " +
        'Réponds UNIQUEMENT en JSON: {"subject": string, "body": string}. body = corps de l\'e-mail complet (salutation, contexte facture, demande de paiement, formule de politesse), sans pièce jointe ni signature électronique.',
      prompt:
        `Facture ${data.invoiceNumber} — client : ${data.clientName}\nMontant : ${formatMoney(Number(data.amount ?? 0), data.currency)}\n` +
        `Émise le ${data.issuedAt}, échue le ${data.dueDate} (retard : ${lateDays} jours)\n` +
        `Niveau de relance demandé : ${body.level}. ${LEVEL_INSTRUCTIONS[body.level]}\n` +
        (body.senderName ? `Signe au nom de : ${body.senderName}\n` : "") +
        "Rédige l'e-mail de relance.",
      task: "document",
      temperature: 0.4,
      maxTokens: 1_200,
    });

    let email: { subject: string; body: string };
    try {
      const { extractJsonObject } = await import("@/lib/engines/ai-engine");
      const parsedEmail = z.object({ subject: z.string().min(3).max(200), body: z.string().min(50).max(8_000) }).parse(extractJsonObject(result.text));
      email = parsedEmail;
    } catch {
      // Repli : le texte brut devient le corps — la relance reste exploitable.
      email = { subject: `Relance — facture ${data.invoiceNumber}`, body: result.text };
    }

    const reminders = [...(data.reminders ?? []), { level: body.level, sentAt: new Date().toISOString(), ...email }];
    const nextStatus = body.level === "courtoise" ? "reminded_1" : body.level === "ferme" ? "reminded_2" : "escalated";
    const updated = await updateRecord(COLLECTION, user.uid, record.id, { reminders, status: nextStatus, lastReminderAt: new Date().toISOString() });

    await emitBusinessEvent({
      userId: user.uid,
      eventType: "finance.invoice_reminded",
      payload: { invoiceId: record.id, invoiceNumber: data.invoiceNumber, level: body.level, lateDays },
    }).catch(() => undefined);

    return NextResponse.json({ invoice: unfoldRecord(updated), email });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Relance impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 300 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
    const data = record.data as { invoiceNumber?: string; amount?: number; currency?: string; status?: string };

    const updated = await updateRecord(COLLECTION, user.uid, record.id, {
      status: parsed.data.status,
      ...(parsed.data.status === "paid" ? { paidAt: new Date().toISOString() } : {}),
    });

    if (parsed.data.status === "paid" && data.status !== "paid") {
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "finance.invoice_paid",
        payload: { invoiceId: record.id, invoiceNumber: String(data.invoiceNumber ?? ""), amount: Number(data.amount ?? 0), currency: String(data.currency ?? "EUR") },
      }).catch(() => undefined);
    }

    return NextResponse.json({ invoice: unfoldRecord(updated) });
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
    if (!deleted) return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
