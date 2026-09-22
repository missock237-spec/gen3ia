import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { runAIJSON } from "@/lib/engines/ai-engine";
import { buildDocument } from "@/lib/engines/document-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Module Marketing — Webinar → Content.
 * Recycle la transcription d'un webinar en un kit de contenus complet
 * (post LinkedIn, e-mail de suivi, article de blog, thread X) via l'AI
 * Engine, avec export documentaire du kit.
 */

const COLLECTION = "marketingWebinarAssets";

const WebinarOutputsSchema = z.object({
  linkedinPost: z.string().min(40).max(3_000),
  followUpEmail: z.string().min(40).max(4_000),
  blogArticle: z.string().min(200).max(12_000),
  xThread: z.array(z.string().min(10).max(280)).min(3).max(12),
  keyQuotes: z.array(z.string()).max(8).default([]),
});
export type WebinarOutputs = z.infer<typeof WebinarOutputsSchema>;

const CreateSchema = z.object({
  action: z.literal("create"),
  title: z.string().trim().min(2).max(160),
  audience: z.string().trim().max(300).default(""),
  transcript: z.string().trim().min(200).max(60_000),
});
const ExportSchema = z.object({ action: z.literal("export"), id: z.string().min(1) });
const BodySchema = z.discriminatedUnion("action", [CreateSchema, ExportSchema]);

function outputsToMarkdown(title: string, outputs: WebinarOutputs): string {
  return [
    `# Kit de contenus — ${title}`,
    "",
    "## Post LinkedIn",
    outputs.linkedinPost,
    "",
    "## E-mail de suivi",
    outputs.followUpEmail,
    "",
    "## Article de blog",
    outputs.blogArticle,
    "",
    "## Thread X",
    ...outputs.xThread.map((tweet, index) => `${index + 1}. ${tweet}`),
    "",
    "## Citations clés",
    ...outputs.keyQuotes.map((quote) => `- « ${quote} »`),
  ].join("\n");
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:webinar:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 50 });
    return NextResponse.json({ assets: records.map(unfoldRecord) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Kits webinar indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const body = parsed.data;

    if (body.action === "create") {
      const result = await runAIJSON({
        userId: user.uid,
        feature: "marketing-webinar",
        system:
          "Tu es un stratège de contenu B2B. Tu transformes des transcriptions de webinars en contenus prêts à publier, fidèles aux propos tenus. " +
          'Réponds UNIQUEMENT en JSON: {"linkedinPost": string, "followUpEmail": string, "blogArticle": string, "xThread": string[], "keyQuotes": string[]}. ' +
          "Le post LinkedIn fait 150-220 mots avec une accroche forte et une question finale. L'e-mail remercie, résume 3 apports et propose une suite. L'article fait 500-800 mots structuré avec des sous-titres markdown (##). Le thread X compte 5 à 8 tweets numérotés par le tableau.",
        prompt:
          `Titre du webinar : ${body.title}\n${body.audience ? `Audience : ${body.audience}\n` : ""}TRANSCRIPTION :\n"""\n${body.transcript.slice(0, 45_000)}\n"""`,
        schema: WebinarOutputsSchema,
        label: "kit de contenus webinar",
        maxTokens: 4_000,
      });

      const record = await createRecord({
        userId: user.uid,
        collection: COLLECTION,
        data: {
          title: body.title,
          audience: body.audience,
          transcriptPreview: body.transcript.slice(0, 500),
          outputs: result.data,
          artifactId: null,
        },
      });
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "marketing.content_generated",
        payload: { assetId: record.id, title: body.title },
      }).catch(() => undefined);
      return NextResponse.json({ asset: unfoldRecord(record), provider: result.provider }, { status: 201 });
    }

    // action === "export"
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 100 });
    const asset = records.find((r) => r.id === body.id);
    if (!asset) return NextResponse.json({ error: "Kit introuvable." }, { status: 404 });
    const outputs = (asset.data as { outputs?: WebinarOutputs }).outputs;
    if (!outputs) return NextResponse.json({ error: "Aucun contenu à exporter." }, { status: 400 });
    const title = String((asset.data as { title?: string }).title ?? "Webinar");
    const doc = await buildDocument({
      userId: user.uid,
      feature: "marketing-webinar",
      title: `Kit contenus — ${title}`,
      format: "docx",
      markdown: outputsToMarkdown(title, outputs),
    });
    return NextResponse.json({ artifactId: doc.artifactId, filename: doc.filename });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Génération impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteRecord(COLLECTION, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Kit introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
