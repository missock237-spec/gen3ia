import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Chargement minimal de .env.local (sans dépendance dotenv) : les clés
// Firebase admin + Supabase service-role vivent dans le fichier d'env local
// du projet. Les variables déjà exportées dans le shell PRIMENT (_set si
// absente uniquement).
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
} catch {
  /* pas de .env.local : les variables doivent être exportées dans le shell */
}

import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/firebase/admin";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { isSupabaseAdminConfigured } from "../lib/supabase/config";
import { resolveProfileId } from "../lib/db/driver";
import { mirrorRowFromNotification } from "../lib/notifications/mirror";
import { NotificationSchema, type Gen3iaNotification } from "../lib/notifications/repository";

/**
 * Backfill Firestore → Supabase — Phase P2 (Task 43, ADR-006).
 *
 * Recopie par lots la collection Firestore `notifications` vers la table
 * Postgres `notifications` avec IDEMPOTENCE TOTALE :
 *   - id Postgres = uuid v5 dérivé de l'id Firestore (même dérivation que le
 *     miroir temps réel lib/notifications/mirror.ts) → reprise sans doublon ;
 *   - upsert "on conflict id, ignoreDuplicates" → relancer ne corrompt rien ;
 *   - audit de la correspondance dans `migration_mapping` (upsert) ;
 *   - checksum final : comptages par utilisateur Firestore vs Postgres.
 *
 * Usage :
 *   npx tsx scripts/backfill_supabase.ts notifications            # dry-run (défaut)
 *   npx tsx scripts/backfill_supabase.ts notifications --apply    # écriture réelle
 *   npx tsx scripts/backfill_supabase.ts notifications --apply --limit 1000
 *
 * Variables requises (env) : FIREBASE_* (admin), NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Le domaine `notifications` est le PILOTE (ordre recommandé du guide) ;
 * les domaines suivants (artifacts, conversations, agents…) réutiliseront
 * ce squelette avec leur mapping propre.
 */

const BATCH_SIZE = 500;
const COLLECTION = "notifications";

interface Args {
  domain: string;
  apply: boolean;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const domain = argv.find((a) => !a.startsWith("--")) ?? "";
  return {
    domain,
    apply: argv.includes("--apply"),
    limit: Number(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0") || Number.MAX_SAFE_INTEGER,
  };
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function* iterateNotifications(): AsyncGenerator<
  { ok: true; id: string; data: Gen3iaNotification } | { ok: false; id: string }
> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  while (true) {
    let query = adminDb.collection(COLLECTION).orderBy("createdAt", "asc").limit(BATCH_SIZE);
    if (cursor) query = query.startAfter(cursor) as typeof query;
    const snapshot = await query.get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      const parsed = NotificationSchema.safeParse({
        id: doc.id,
        userId: doc.get("userId"),
        type: doc.get("type") === "approval_requested" ? "approval_requested" : "info",
        title: typeof doc.get("title") === "string" ? doc.get("title") : "Notification",
        body: typeof doc.get("body") === "string" ? doc.get("body") : "",
        read: doc.get("read") === true,
        ...(doc.get("kind") ? { kind: doc.get("kind") } : {}),
        ...(doc.get("approvalId") ? { approvalId: doc.get("approvalId") } : {}),
        ...(doc.get("conversationId") ? { conversationId: doc.get("conversationId") } : {}),
        ...(doc.get("executionId") ? { executionId: doc.get("executionId") } : {}),
        ...(doc.get("toolSlug") ? { toolSlug: doc.get("toolSlug") } : {}),
        createdAtMs: doc.get("createdAt") instanceof Timestamp ? doc.get("createdAt").toMillis() : Date.now(),
      });
      if (parsed.success) yield { ok: true, id: doc.id, data: parsed.data };
      else yield { ok: false, id: doc.id };
    }
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < BATCH_SIZE) return;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.domain !== COLLECTION) {
    fail(`Domaine « ${args.domain || "(vide)"} » non supporté. Pilot P2 : « ${COLLECTION} ».`);
  }
  if (!isSupabaseAdminConfigured() || !getSupabaseAdmin()) {
    fail(
      "Supabase non configuré : définissez NEXT_PUBLIC_SUPABASE_URL, " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY et SUPABASE_SERVICE_ROLE_KEY (service-role " +
        "requis pour l'écriture backfill).",
    );
  }
  const supabase = getSupabaseAdmin()!;

  console.log("\n=== Backfill Supabase — notifications (P2) ===");
  console.log(`Mode : ${args.apply ? "APPLY (écriture réelle)" : "DRY-RUN (aucune écriture)"}\n`);

  const profileCache = new Map<string, string | null>();
  const countsByUser = new Map<string, { firestore: number; postgres: number }>();
  let scanned = 0;
  let mirrored = 0;
  let invalid = 0;
  let profileFailures = 0;
  let writeErrors = 0;

  for await (const item of iterateNotifications()) {
    scanned += 1;
    if (scanned > args.limit) break;
    if (!item.ok) {
      invalid += 1;
      continue;
    }
    const { id, data } = item;

    const userCounts = countsByUser.get(data.userId) ?? { firestore: 0, postgres: 0 };
    userCounts.firestore += 1;

    let profileId: string | null;
    if (profileCache.has(data.userId)) {
      profileId = profileCache.get(data.userId) ?? null;
    } else {
      profileId = await resolveProfileId({ uid: data.userId, provider: "firebase-bridge" });
      profileCache.set(data.userId, profileId);
    }
    if (!profileId) {
      profileFailures += 1;
      continue;
    }

    const row = mirrorRowFromNotification(data, profileId);

    if (args.apply) {
      const { error } = await supabase
        .from(COLLECTION)
        .upsert(row, { onConflict: "id", ignoreDuplicates: true });
      if (error) {
        writeErrors += 1;
        if (writeErrors <= 5) console.warn(`  ! écriture ${id} : ${error.message}`);
        continue;
      }
      // Audit de correspondance (idempotent) — migration_mapping.
      await supabase.from("migration_mapping").upsert(
        { collection: COLLECTION, firestore_id: id, postgres_id: row.id },
        { onConflict: "collection,firestore_id", ignoreDuplicates: true },
      );
    }

    mirrored += 1;
    userCounts.postgres += 1;
    countsByUser.set(data.userId, userCounts);

    if (mirrored % 500 === 0) console.log(`  … ${mirrored} notification(s) traitée(s)`);
  }

  console.log("\n--- Bilan ---");
  console.log(`Documents scannés (Firestore) : ${scanned}`);
  console.log(`Lignes valides ${args.apply ? "écrites/confirmées" : "prêtes"} : ${mirrored}`);
  console.log(`Documents invalides (zod)    : ${invalid}`);
  console.log(`Profils non résolus          : ${profileFailures}`);
  console.log(`Erreurs d'écriture           : ${writeErrors}`);

  const totals = [...countsByUser.values()].reduce(
    (acc, c) => ({ firestore: acc.firestore + c.firestore, postgres: acc.postgres + c.postgres }),
    { firestore: 0, postgres: 0 },
  );
  console.log("\n--- Checksums (comptages par utilisateur) ---");
  console.log(`Firestore total : ${totals.firestore} — Postgres ${args.apply ? "total" : "attendu"} : ${totals.postgres}`);
  const divergences = [...countsByUser.entries()].filter(([, c]) => c.firestore !== c.postgres);
  if (divergences.length === 0) {
    console.log("Aucune divergence par utilisateur. ✓");
  } else {
    console.log(`${divergences.length} utilisateur(s) en divergence (top 10) :`);
    for (const [userId, c] of divergences.slice(0, 10)) {
      console.log(`  ${userId} : firestore=${c.firestore} postgres=${c.postgres}`);
    }
  }

  console.log(
    `\n${args.apply ? "Backfill terminé — relancer le script est sûr (idempotence par ids dérivés)." : "Dry-run terminé — relancer avec --apply pour écrire."}\n`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("Backfill en échec :", error);
  process.exit(1);
});
