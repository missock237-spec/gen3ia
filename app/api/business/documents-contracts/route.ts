import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { runAIJSON } from "@/lib/engines/ai-engine";
import { buildDocument, proofDocument } from "@/lib/engines/document-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Module Documents — Contrats.
 * Rédaction assistée par l'AI Engine (clauses standard adaptées aux termes
 * fournis), export PDF signable via le Document Engine, suivi de statut
 * (brouillon → envoyé → signé) avec preuve horodatée à la signature.
 */

const COLLECTION = "businessContracts";

const ContractTypeSchema = z.enum(["service", "nda", "sale", "employment", "partnership"]);

const ContractBodySchema = z.object({
  body: z.string().min(300).max(20_000),
  clausesCount: z.number().int().min(3).max(40),
  notice: z.string().max(600),
});

const CreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  clientName: z.string().trim().min(2).max(160),
  type: ContractTypeSchema.default("service"),
  amount: z.number().min(0).max(100_000_000).optional(),
  currency: z.string().length(3).default("EUR"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentTerms: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(2_000).optional(),
});

const PatchSchema = z.object({ id: z.string().min(1), status: z.enum(["draft", "sent", "signed", "archived"]) });
const ExportSchema = z.object({ action: z.literal("export"), id: z.string().min(1) });
const CreateBodySchema = CreateSchema.extend({ action: z.literal("create") });
const BodySchema = z.discriminatedUnion("action", [CreateBodySchema, ExportSchema]);

const TYPE_LABELS: Record<z.infer<typeof ContractTypeSchema>, string> = {
  service: "prestation de services",
  nda: "accord de confidentialité (NDA)",
  sale: "vente de biens",
  employment: "contrat de travail",
  partnership: "partenariat commercial",
};

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:contracts:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 60 });
    return NextResponse.json({ contracts: records.map(unfoldRecord) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Contrats indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const body = parsed.data;

    if (body.action === "create") {
      const { action: _action, ...terms } = body;
      const result = await runAIJSON({
        userId: user.uid,
        feature: "documents-contracts",
        system:
          "Tu es un juriste d'affaires francophone. Tu rédiges des contrats clairs, équilibrés, en français, avec des clauses standard (objet, obligations, durée, rémunération, confidentialité, résiliation, droit applicable). " +
          'Réponds UNIQUEMENT en JSON: {"body": string, "clausesCount": number, "notice": string}. ' +
          "body = le texte intégral du contrat en markdown (titres ##, articles numérotés, tableaux si utile). notice = avertissement : ce modèle ne remplace pas un conseil juridique professionnel.",
        prompt:
          `Type de contrat : ${TYPE_LABELS[terms.type]}\nClient/Partie : ${terms.clientName}\n` +
          (terms.amount !== undefined ? `Montant : ${terms.amount} ${terms.currency}\n` : "") +
          (terms.startDate ? `Début : ${terms.startDate}\n` : "") +
          (terms.endDate ? `Fin : ${terms.endDate}\n` : "") +
          (terms.paymentTerms ? `Conditions de paiement : ${terms.paymentTerms}\n` : "") +
          (terms.notes ? `Précisions : ${terms.notes}\n` : "") +
          `Titre : ${terms.title}\n\nRédige le contrat complet.`,
        schema: ContractBodySchema,
        label: "corps de contrat",
        maxTokens: 4_000,
      });

      // Export PDF immédiat : le contrat doit être téléchargeable dès sa création.
      const doc = await buildDocument({
        userId: user.uid,
        feature: "documents-contracts",
        title: terms.title,
        format: "pdf",
        markdown: result.data.body,
      });

      const record = await createRecord({
        userId: user.uid,
        collection: COLLECTION,
        data: {
          title: terms.title,
          clientName: terms.clientName,
          type: terms.type,
          ...(terms.amount !== undefined ? { amount: terms.amount, currency: terms.currency } : {}),
          ...(terms.startDate ? { startDate: terms.startDate } : {}),
          ...(terms.endDate ? { endDate: terms.endDate } : {}),
          ...(terms.paymentTerms ? { paymentTerms: terms.paymentTerms } : {}),
          ...(terms.notes ? { notes: terms.notes } : {}),
          body: result.data.body,
          clausesCount: result.data.clausesCount,
          notice: result.data.notice,
          status: "draft",
          artifactId: doc.artifactId,
          filename: doc.filename,
        },
      });
      return NextResponse.json({ contract: unfoldRecord(record) }, { status: 201 });
    }

    // action === "export" (régénère le PDF depuis le corps stocké)
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 100 });
    const contract = records.find((r) => r.id === body.id);
    if (!contract) return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
    const contractBody = (contract.data as { body?: string }).body;
    if (!contractBody) return NextResponse.json({ error: "Ce contrat n'a pas de corps rédigé." }, { status: 400 });
    const doc = await buildDocument({
      userId: user.uid,
      feature: "documents-contracts",
      title: String((contract.data as { title?: string }).title ?? "Contrat"),
      format: "pdf",
      markdown: contractBody,
    });
    await updateRecord(COLLECTION, user.uid, contract.id, { artifactId: doc.artifactId, filename: doc.filename });
    return NextResponse.json({ artifactId: doc.artifactId, filename: doc.filename });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Génération du contrat impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 200 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
    const data = record.data as { title?: string; clientName?: string };

    const updated = await updateRecord(COLLECTION, user.uid, record.id, {
      status: parsed.data.status,
      ...(parsed.data.status === "signed" ? { signedAt: new Date().toISOString() } : {}),
    });

    // Signature → preuve horodatée archivable + événement métier.
    if (parsed.data.status === "signed") {
      await proofDocument({
        userId: user.uid,
        feature: "documents-contracts",
        title: `Preuve de signature — ${String(data.title ?? record.id)}`,
        facts: [
          { label: "Contrat", value: String(data.title ?? record.id) },
          { label: "Client", value: String(data.clientName ?? "") },
          { label: "Statut", value: "Signé" },
          { label: "Horodatage UTC", value: new Date().toISOString() },
        ],
      });
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "documents.contract_signed",
        payload: { contractId: record.id, title: String(data.title ?? ""), clientName: String(data.clientName ?? "") },
      }).catch(() => undefined);
    }

    return NextResponse.json({ contract: unfoldRecord(updated) });
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
    if (!deleted) return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
