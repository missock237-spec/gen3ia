import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { deletePromptTemplate } from "@/lib/domain/prompt-templates/repository";

/**
 * Task 141 — suppression d'un PROMPT TEMPLATE de l'utilisateur connecté.
 */

type RouteContext = { params: Promise<{ templateId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { templateId } = await params;
    const removed = await deletePromptTemplate(user.uid, templateId);
    if (!removed) {
      return NextResponse.json({ error: "Modèle introuvable." }, { status: 404 });
    }
    return NextResponse.json({ removed: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression du modèle impossible"), { status: errorStatus(error) });
  }
}
