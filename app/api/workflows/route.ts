import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { adminDb } from "@/lib/firebase/admin";
import { WorkflowSchema } from "@/lib/workflows/types";
import { validateWorkflow } from "@/lib/workflows/validator";
import { assertOrgAttach, listUserOrgIds } from "@/lib/tenants/resource-access";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Workflows — graphes exécutables (nœuds agent/tool/condition/parallel/
 * approval/transform/output).
 *  GET  /api/workflows              → liste des workflows du propriétaire ;
 *  POST /api/workflows              → création (validation graphe + cycles).
 */

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // Union org-aware (recommandation C) : workflows personnels + workflows
    // des organisations de l'utilisateur (orgIds résolus SERVEUR, chunks ≤30).
    const orgIds = await listUserOrgIds(user.uid);
    const chunks: string[][] = [];
    for (let i = 0; i < orgIds.length; i += 30) chunks.push(orgIds.slice(i, i + 30));
    const snapshots = await Promise.all([
      adminDb.collection("workflows").where("userId", "==", user.uid).limit(100).get(),
      ...chunks.map((ids) => adminDb.collection("workflows").where("orgId", "in", ids).limit(100).get()),
    ]);
    const byId = new Map<string, Record<string, unknown>>();
    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        if (!byId.has(doc.id)) byId.set(doc.id, { id: doc.id, createdAt: "", updatedAt: "", ...doc.data() as Record<string, unknown> });
      }
    }
    const workflows = [...byId.values()]
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return NextResponse.json({ workflows });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Liste des workflows indisponible"), { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`workflow-create:${user.uid}`, { limit: 30, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite de création atteinte.", requestId }, { status: 429 });

    const body = await request.json();
    const parsed = WorkflowSchema.safeParse({ ...body, id: "probe", version: 1 });
    if (!parsed.success) {
      return NextResponse.json({ error: "Structure de workflow invalide.", issues: parsed.error.flatten(), requestId }, { status: 422 });
    }
    const validation = validateWorkflow(parsed.data);
    if (!validation.valid) {
      return NextResponse.json({ error: `Workflow invalide : ${validation.errors.join(" | ")}`, requestId }, { status: 422 });
    }

    // Rattachement org optionnel : la politique centralisée vérifie
    // l'appartenance AVANT l'écriture (jamais de publication dans une org
    // dont l'appelant ne fait pas partie).
    const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
    if (orgId) await assertOrgAttach(user.uid, orgId);
    const id = randomUUID();
    const now = new Date().toISOString();
    await adminDb.collection("workflows").doc(id).set({
      ...body,
      ...(orgId ? { orgId } : {}),
      id,
      version: 1,
      userId: user.uid,
      createdAt: now,
      updatedAt: now,
    } as Record<string, unknown>);
    return NextResponse.json({ id, createdAt: now, requestId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création du workflow impossible"), { status: errorStatus(error, 500) });
  }
}
