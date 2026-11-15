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
 * Module Documents — Onboarding.
 * Parcours d'intégration générés depuis des templates par rôle (employé,
 * client, prestataire) : étapes ordonnées avec échéances en jours,
 * cochage progressif, complétion automatique + événement métier.
 */

const COLLECTION = "businessOnboardingFlows";

const RoleSchema = z.enum(["employee", "client", "contractor"]);

interface StepTemplate {
  title: string;
  dueInDays: number;
}

const TEMPLATES: Record<z.infer<typeof RoleSchema>, StepTemplate[]> = {
  employee: [
    { title: "Contrat de travail signé et archivé", dueInDays: 0 },
    { title: "Création des accès (e-mail, outils internes)", dueInDays: 1 },
    { title: "Séance d'accueil et présentation de l'équipe", dueInDays: 1 },
    { title: "Formation sécurité informatique & RGPD", dueInDays: 5 },
    { title: "Définition des objectifs de période d'essai", dueInDays: 7 },
    { title: "Point de suivi à 30 jours", dueInDays: 30 },
  ],
  client: [
    { title: "Contrat signé et compte client créé", dueInDays: 0 },
    { title: "Appel de cadrage des besoins", dueInDays: 2 },
    { title: "Collecte des accès et informations nécessaires", dueInDays: 5 },
    { title: "Livraison du premier livrable", dueInDays: 10 },
    { title: "Point de satisfaction à 30 jours", dueInDays: 30 },
  ],
  contractor: [
    { title: "Convention de prestation signée", dueInDays: 0 },
    { title: "Accès projet et outillage fournis", dueInDays: 1 },
    { title: "Cadrage du périmètre et des livrables", dueInDays: 3 },
    { title: "Validation des modalités de facturation", dueInDays: 5 },
  ],
};

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  role: RoleSchema.default("employee"),
  targetName: z.string().trim().min(2).max(120),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const PatchSchema = z.object({ id: z.string().min(1), stepIndex: z.number().int().min(0).max(50) });

interface FlowStep {
  title: string;
  dueInDays: number;
  done: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:onboarding:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });
    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 60 });
    const flows = records.map(unfoldRecord);
    const active = flows.filter((f) => (f as { status?: string }).status !== "completed").length;
    return NextResponse.json({ flows, kpis: { total: flows.length, active, completed: flows.length - active } });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Parcours d'onboarding indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = CreateSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });

    const template = TEMPLATES[parsed.data.role];
    const steps: FlowStep[] = template.map((step) => ({ title: step.title, dueInDays: step.dueInDays, done: false }));

    const record = await createRecord({
      userId: user.uid,
      collection: COLLECTION,
      data: {
        name: parsed.data.name,
        role: parsed.data.role,
        targetName: parsed.data.targetName,
        ...(parsed.data.dueDate ? { dueDate: parsed.data.dueDate } : {}),
        steps,
        status: "in_progress",
      },
    });
    return NextResponse.json({ flow: unfoldRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création du parcours impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, fresh: true, limit: 200 });
    const record = records.find((r) => r.id === parsed.data.id);
    if (!record) return NextResponse.json({ error: "Parcours introuvable." }, { status: 404 });

    const data = record.data as { steps?: FlowStep[]; name?: string; targetName?: string; status?: string };
    const steps = data.steps ?? [];
    if (parsed.data.stepIndex >= steps.length) return NextResponse.json({ error: "Étape inexistante." }, { status: 400 });
    steps[parsed.data.stepIndex] = { ...steps[parsed.data.stepIndex], done: !steps[parsed.data.stepIndex].done };

    const allDone = steps.every((s) => s.done);
    const wasCompleted = data.status === "completed";
    const updated = await updateRecord(COLLECTION, user.uid, record.id, { steps, status: allDone ? "completed" : "in_progress" });

    if (allDone && !wasCompleted) {
      await emitBusinessEvent({
        userId: user.uid,
        eventType: "documents.onboarding_completed",
        payload: { flowId: record.id, name: String(data.name ?? ""), targetName: String(data.targetName ?? "") },
      }).catch(() => undefined);
    }

    return NextResponse.json({ flow: unfoldRecord(updated) });
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
    if (!deleted) return NextResponse.json({ error: "Parcours introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
