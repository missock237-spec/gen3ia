import { NextResponse } from "next/server";

import { timingSafeStringEqual } from "@/lib/security/timing-safe";
import { importSkillsShCatalog } from "@/lib/skills/sh-importer";

/**
 * Import du catalogue skills.sh (écosystème ouvert Vercel Labs) vers la
 * bibliothèque de skills Gen3ia (R2). Idempotent : re-importer un
 * SKILL.md inchangé n'écrit rien.
 *
 * Auth (une seule suffit) :
 *  - Bearer CRON_SECRET — cron serveur (contrat commun aux routes /api/cron) ;
 *  - utilisateur authentifié Firebase — déclenchement manuel depuis l'app.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const authorization = request.headers.get("authorization") ?? "";
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

async function firebaseAuthorized(request: Request): Promise<boolean> {
  try {
    const { verifyFirebaseAuth } = await import("@/lib/firebase/auth-server");
    await verifyFirebaseAuth(request);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    if (!cronAuthorized(request) && !(await firebaseAuthorized(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const imported = await importSkillsShCatalog();
    return NextResponse.json({
      ok: true,
      total: imported.length,
      created: imported.filter((skill) => !skill.skipped).length,
      skills: imported.map(({ id, name, version, skipped }) => ({ id, name, version, skipped })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import skills.sh failed" },
      { status: 500 },
    );
  }
}
