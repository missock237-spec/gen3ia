import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, updateRecord, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { runAIJSON } from "@/lib/engines/ai-engine";
import { buildDocument } from "@/lib/engines/document-engine";
import { emitBusinessEvent } from "@/lib/engines/events";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Module Marketing — Landing Pages.
 * Génération assistée par l'AI Engine (structure complète : hero, bénéfices,
 * sections, CTA), export PDF via le Document Engine, publication avec
 * événement métier consommable par les automatisations.
 */

const COLLECTION = "marketingLandingPages";

const LandingContentSchema = z.object({
  headline: z.string().min(3).max(160),
  subheadline: z.string().min(3).max(400),
  benefits: z.array(z.object({ title: z.string().max(120), body: z.string().max(400) })).min(1).max(8),
  sections: z.array(z.object({ title: z.string().max(120), body: z.string().max(1_200) })).max(6),
  cta: z.string().min(2).max(120),
  seoKeywords: z.array(z.string()).max(10).default([]),
});
export type LandingContent = z.infer<typeof LandingContentSchema>;

const CreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(2).max(120),
  product: z.string().trim().min(2).max(400),
  audience: z.string().trim().min(2).max(400),
  tone: z.enum(["professionnel", "amical", "audacieux", "premium", "technique"]).default("professionnel"),
  language: z.enum(["fr", "en"]).default("fr"),
  features: z.array(z.string().trim().min(1).max(160)).min(1).max(10),
});

const GenerateSchema = z.object({ action: z.literal("generate"), id: z.string().min(1) });
const PublishSchema = z.object({ action: z.literal("publish"), id: z.string().min(1) });
const ExportSchema = z.object({ action: z.literal("export"), id: z.string().min(1) });
const BodySchema = z.discriminatedUnion("action", [CreateSchema, GenerateSchema, PublishSchema, ExportSchema]);

function landingToMarkdown(content: LandingContent): string {
  return [
    `# ${content.headline}`,
    "",
    content.subheadline,
    "",
    "## Bénéfices clés",
    ...content.benefits.map((b) => `- **${b.title}** — ${b.body}`),
    "",
    ...content.sections.flatMap((s) => [`## ${s.title}`, "", s.body, ""]),
    `**Passer à l'action : ${content.cta}**`,
  ].join("\n");
}

async function findPage(userId: string, id: string) {
  const pages = await listRecords({ userId, collection: COLLECTION, fresh: true, limit: 100 });
  const page = pages.find((r) => r.id === id);
  if (!page) throw new Error("Landing page introuvable.");
  return page;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:landing:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 60 });
    return NextResponse.json({ pages: records.map(unfoldRecord) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Landing pages indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });

    if (parsed.data.action === "create") {
      const record = await createRecord({
        userId: user.uid,
        collection: COLLECTION,
        data: {
          name: parsed.data.name,
          product: parsed.data.product,
          audience: parsed.data.audience,
          tone: parsed.data.tone,
          language: parsed.data.language,
          features: parsed.data.features,
          status: "draft",
          content: null,
          artifactId: null,
        },
      });
      return NextResponse.json({ page: unfoldRecord(record) }, { status: 201 });
    }

    if (parsed.data.action === "generate") {
      const page = await findPage(user.uid, parsed.data.id);
      const data = page.data as Record<string, unknown>;

      const result = await runAIJSON({
        userId: user.uid,
        feature: "marketing-landing",
        system:
          "Tu es un copywriter de conversion senior. Tu écris des landing pages percutantes, concrètes, orientées bénéfices clients. " +
          'Réponds UNIQUEMENT en JSON: {"headline": string, "subheadline": string, "benefits": [{"title": string, "body": string}], "sections": [{"title": string, "body": string}], "cta": string, "seoKeywords": string[]}.',
        prompt:
          `Produit/Service : ${String(data.product)}\nAudience cible : ${String(data.audience)}\nTon : ${String(data.tone)}\n` +
          `Fonctionnalités à valoriser :\n${(data.features as string[]).map((f) => `- ${f}`).join("\n")}\n\n` +
          `Rédige la landing page complète en ${String(data.language) === "en" ? "ANGLAIS" : "FRANÇAIS"} : accroche, sous-accroche, 3 à 5 bénéfices concrets (pas des fonctionnalités brutes), 2 à 3 sections de développement, un appel à l'action et des mots-clés SEO.`,
        schema: LandingContentSchema,
        label: "contenu de landing page",
        maxTokens: 2_400,
      });

      const updated = await updateRecord(COLLECTION, user.uid, page.id, { content: result.data, status: "draft" });
      return NextResponse.json({ page: unfoldRecord(updated), provider: result.provider, model: result.model });
    }

    if (parsed.data.action === "publish") {
      const page = await findPage(user.uid, parsed.data.id);
      if (!(page.data as { content?: unknown }).content) {
        return NextResponse.json({ error: "Générez d'abord le contenu avant de publier." }, { status: 400 });
      }
      const updated = await updateRecord(COLLECTION, user.uid, page.id, { status: "published" });
      const data = page.data as { name?: string; content?: LandingContent };
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "marketing.landing_published",
        payload: { landingId: page.id, name: String(data.name ?? ""), headline: String(data.content?.headline ?? "") },
      }).catch(() => undefined);
      return NextResponse.json({ page: unfoldRecord(updated) });
    }

    // action === "export"
    const page = await findPage(user.uid, parsed.data.id);
    const content = (page.data as { content?: LandingContent }).content;
    if (!content) return NextResponse.json({ error: "Générez d'abord le contenu." }, { status: 400 });
    const doc = await buildDocument({
      userId: user.uid,
      feature: "marketing-landing",
      title: `Landing — ${String((page.data as { name?: string }).name ?? page.id)}`,
      format: "pdf",
      markdown: landingToMarkdown(content),
    });
    await updateRecord(COLLECTION, user.uid, page.id, { artifactId: doc.artifactId });
    return NextResponse.json({ artifactId: doc.artifactId, filename: doc.filename });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Action landing page impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteRecord(COLLECTION, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Landing page introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
