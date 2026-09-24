import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { listMemories, remember, forget, getMemoryEntry } from "@/lib/memory/user-memory";
import { evaluateDuplicateWrite } from "@/lib/memory/keyvalue";
import { errorStatus } from "@/lib/security/http-errors";

const WriteSchema = z.object({
  key: z.string().min(1).max(160),
  value: z.unknown(),
  // Consentement explicite d'écrasement (contrat anti-écrasement silencieux).
  overwrite: z.boolean().optional(),
});
const DeleteSchema = z.object({ key: z.string().min(1).max(160) });

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  return NextResponse.json({ memories: await listMemories(guard.context.userId) }, { headers: { "cache-control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  try {
    const input = WriteSchema.parse(await request.json());
    // Contrat de doublon (choix SaaS entreprise, documenté dans lib/memory/keyvalue.ts) :
    //  - clé inexistante                    → écriture normale (200 { ok: true }) ;
    //  - clé existante, valeur IDENTIQUE    → 200 idempotent (aucune réécriture : la
    //    date de mise à jour d'origine est préservée, répéter l'appel est sans effet) ;
    //  - clé existante, valeur DIFFÉRENTE   → 409 { error, code: "MEMORY_KEY_EXISTS",
    //    existingUpdatedAt } SANS écrire. L'écrasement silencieux historique rendait
    //    la perte de données invisible ; il exige désormais un consentement explicite
    //    via le champ `overwrite: true` du corps (ou `?overwrite=true` en requête).
    // Limite connue (documentée) : la vérification puis l'écriture ne sont pas dans
    // une transaction Firestore stricte — fenêtre de course identique à celle du
    // compteur de quota existant ; acceptable pour un usage mono-utilisateur.
    const overwrite = input.overwrite === true || request.nextUrl.searchParams.get("overwrite") === "true";
    const existing = await getMemoryEntry(guard.context.userId, input.key);
    const decision = evaluateDuplicateWrite({
      exists: existing !== null,
      existingValue: existing?.value,
      incomingValue: input.value,
      overwrite,
    });
    if (decision.action === "identical") {
      return NextResponse.json({ ok: true, duplicate: true }, { headers: { "cache-control": "no-store" } });
    }
    if (decision.action === "conflict") {
      return NextResponse.json(
        {
          error: "Un souvenir existe déjà pour cette clé avec une valeur différente. Confirmez l'écrasement en renvoyant la requête avec overwrite:true.",
          code: "MEMORY_KEY_EXISTS",
          existingUpdatedAt: existing?.updatedAt,
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    await remember({ userId: guard.context.userId, key: input.key, value: input.value, source: "user" });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Memory write failed" }, { status: errorStatus(error, 400) }); }
}
export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  try { const input = DeleteSchema.parse(await request.json()); await forget(guard.context.userId, input.key); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Memory delete failed" }, { status: errorStatus(error, 400) }); }
}
