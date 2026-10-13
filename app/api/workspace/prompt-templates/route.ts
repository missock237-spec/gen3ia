import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { listPromptTemplates, savePromptTemplate } from "@/lib/domain/prompt-templates/repository";

/**
 * Task 141 — bibliothèque de PROMPT TEMPLATES (GET liste / POST création).
 * Données strictement personnelles : `users/{uid}/prompt-templates/*`.
 */
const SaveSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
  templateId: z.string().trim().min(1).max(64).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const templates = await listPromptTemplates(user.uid);
    return NextResponse.json({ templates });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Bibliothèque de modèles indisponible"), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`tpl-save:${user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop d'enregistrements de modèles. Réessayez dans un instant." }, { status: 429 });
    }
    const parsed = SaveSchema.parse(await request.json());
    const template = await savePromptTemplate(user.uid, parsed);
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Enregistrement du modèle impossible"), { status: errorStatus(error) });
  }
}
