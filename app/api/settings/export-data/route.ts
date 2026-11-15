import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { recordAuditEventSafe } from "@/lib/security/audit-events";
import { getIdentity } from "@/lib/identity/r2-identity-store";
import { listConversations, listMessages } from "@/lib/chat/repository";
import { listArtifacts } from "@/lib/domain/artifacts/repository";
import { listRecentRuns } from "@/lib/domain/runs/repository";
import { exportUserData } from "@/lib/memory/privacy";
import { createR2DownloadUrl, putObject } from "@/lib/storage/r2";
import { userKey } from "@/lib/storage/user-data-store";

/**
 * EXPORT RGPD SELF-SERVICE (Task 126) — GET /api/settings/export-data.
 *
 * Agrège TOUTES les métadonnées du compte en un JSON auto-descriptif :
 * profil, conversations + messages, artefacts, jobs (runs) et mémoire
 * (souvenirs / retours IA / consentements — exportUserData réutilisé).
 *
 * Livraison : le JSON est déposé dans R2 sous la clé privé de l'utilisateur
 * (`users/{uid}/exports/…`), puis servi via URL SIGNÉE courte (5 min) — le
 * document ne transite jamais dans la réponse API (pas de limite de taille
 * de payload, pas de mise en cache intermédiaire de données personnelles).
 *
 * Garde-fous : session Firebase obligatoire (protectRoute), rate-limit
 * strict (3 exports/heure — opération coûteuse), journal d'audit
 * (`auditEvents`), sections isolées (une section en panne n'annule pas
 * l'export, elle est signalée dans `warnings`).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Bornes de collecte : l'export reste borné en temps serverless. */
const MAX_CONVERSATIONS = 50;
const MESSAGES_PER_CONVERSATION = 200;

/** Capture une section sans faire échouer l'export entier. */
async function section<T>(name: string, op: () => Promise<T>, warnings: string[]): Promise<T | null> {
  try {
    return await op();
  } catch {
    warnings.push(`Section « ${name} » indisponible au moment de l'export.`);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, {
    key: "settings-export-data",
    rateLimit: { limit: 3, windowMs: 60 * 60 * 1000 },
  });
  if (!guard.ok) return guard.response;

  const userId = guard.context.userId;
  const warnings: string[] = [];

  try {
    // 1) Collecte — sections isolées (fail-soft par section, jamais global).
    const [profile, memory, artifacts, runs] = await Promise.all([
      section("profil", () => getIdentity(userId), warnings),
      section("mémoire", () => exportUserData(userId), warnings),
      section("artefacts", () => listArtifacts(userId, { limit: 200 }), warnings),
      section("jobs", () => listRecentRuns(userId, 50), warnings),
    ]);

    const conversations = await section(
      "conversations",
      () => listConversations(userId, MAX_CONVERSATIONS),
      warnings,
    );
    const conversationExports = await Promise.all(
      (conversations ?? []).map(async (conversation) => ({
        conversation,
        messages: await section(
          `messages:${conversation.id}`,
          () => listMessages(userId, conversation.id, MESSAGES_PER_CONVERSATION),
          warnings,
        ),
      })),
    );

    // 2) Document portable auto-descriptif (format versionné).
    const payload = {
      format: "gen3ia.account-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      userId,
      profile,
      conversations: conversationExports,
      artifacts,
      jobs: runs,
      memory,
      warnings,
    };

    // 3) Dépôt R2 sous la clé privée de l'utilisateur, puis URL signée courte.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = userKey(userId, "exports", `account-export-${stamp}`);
    const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    await putObject({ key, body, contentType: "application/json; charset=utf-8" });
    const url = await createR2DownloadUrl(key, 300);

    recordAuditEventSafe({
      actorId: userId,
      actorEmail: guard.context.email ?? null,
      action: "privacy.export_data",
      outcome: "completed",
      targetType: "user",
      targetId: userId,
      metadata: {
        conversations: conversations?.length ?? 0,
        artifacts: artifacts?.length ?? 0,
        jobs: runs?.length ?? 0,
        sizeBytes: body.byteLength,
      },
    });

    return NextResponse.json(
      {
        url,
        expiresInSeconds: 300,
        sizeBytes: body.byteLength,
        counts: {
          conversations: conversations?.length ?? 0,
          artifacts: artifacts?.length ?? 0,
          jobs: runs?.length ?? 0,
        },
        warnings,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    recordAuditEventSafe({
      actorId: userId,
      actorEmail: guard.context.email ?? null,
      action: "privacy.export_data",
      outcome: "failed",
      targetType: "user",
      targetId: userId,
    });
    return NextResponse.json(errorBody(error, "Export des données impossible pour le moment."), {
      status: errorStatus(error),
    });
  }
}
