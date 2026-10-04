import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Chargement minimal de .env.local (sans dépendance dotenv) — mêmes
// conventions que scripts/backfill_supabase.ts : les variables déjà
// exportées dans le shell PRIMENT.
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
} catch {
  /* pas de .env.local : les variables doivent être exportées dans le shell */
}

import { adminDb } from "../lib/firebase/admin";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { isSupabaseAdminConfigured } from "../lib/supabase/config";
import { sanitizeMirrorPayload } from "../lib/db/firestore-fallback";

/**
 * Réchauffage du MIROIR firestore_fallback (Supabase) — Task 96-c.
 *
 * Pourquoi : la couche résiliente (lib/db/firestore-fallback) ne sert des
 * lectures de secours QUE depuis la table `firestore_fallback`. Les
 * conversations/messages/agents créés AVANT l'activation du miroir n'y
 * figurent pas : sous quota Firestore épuisé, l'historique de l'Agent IA
 * serait donc silencieusement vide (miroir froid). Ce script recopie les
 * documents Firestore existants vers le miroir.
 *
 * SÉCURITÉ / IDEMPOTENCE :
 *   - upsert avec `ignoreDuplicates` : une ligne miroir EXISTANTE n'est
 *     JAMAIS écrasée — les écritures miroir plus récentes (posées pendant
 *     une panne de quota, pas encore réconciliées) sont préservées ;
 *   - le payload passe par `sanitizeMirrorPayload` (mêmes conventions que
 *     le miroir temps réel : Timestamp → ISO 8601, sentinelles écartées) ;
 *   - relancer le script ne corrompt rien (dry-run par défaut).
 *
 * Usage :
 *   npm run backfill:fallback                              # dry-run (défaut)
 *   npm run backfill:fallback -- --apply                   # écriture réelle
 *   npm run backfill:fallback -- --apply --limit=1000
 *   npm run backfill:fallback -- --apply --collections=agents
 *
 * NOTE : ce script lit Firestore — à exécuter AVANT l'épuisement du quota
 * (ou après sa réinitialisation quotidienne), jamais pendant la panne.
 *
 * (Le script historique `npm run backfill:supabase` reste dédié au domaine
 * pilote `notifications` — table Postgres dédiée, schéma zod et mapping
 * propres ; il n'était pas extensible à ces collections.)
 */

const DEFAULT_COLLECTIONS = ["chatConversations", "chatMessages", "agents"] as const;
const BATCH_SIZE = 500;

interface Args {
  apply: boolean;
  limit: number;
  collections: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const limitRaw = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const collectionsRaw = argv.find((a) => a.startsWith("--collections="))?.split("=")[1];
  return {
    apply: argv.includes("--apply"),
    limit: Number(limitRaw ?? "0") || Number.MAX_SAFE_INTEGER,
    collections: collectionsRaw
      ? collectionsRaw.split(",").map((c) => c.trim()).filter(Boolean)
      : [...DEFAULT_COLLECTIONS],
  };
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** owner_id miroir : même convention que la couche résiliente (userId sniffé, sinon ownerId explicite des payloads `agents`). */
function mirrorOwnerId(payload: Record<string, unknown>): string | null {
  if (typeof payload.userId === "string" && payload.userId) return payload.userId;
  if (typeof payload.ownerId === "string" && payload.ownerId) return payload.ownerId;
  return null;
}

interface CollectionReport {
  scanned: number;
  inserted: number;
  existing: number;
  empty: number;
  errors: number;
}

async function backfillCollection(
  collection: string,
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  args: Args,
  remaining: () => number,
): Promise<CollectionReport> {
  const report: CollectionReport = { scanned: 0, inserted: 0, existing: 0, empty: 0, errors: 0 };
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  while (report.scanned < remaining()) {
    let query = adminDb.collection(collection).limit(Math.min(BATCH_SIZE, remaining() - report.scanned));
    if (cursor) query = query.startAfter(cursor) as typeof query;
    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      report.scanned += 1;
      const data = doc.data();
      if (!data || Object.keys(data).length === 0) {
        report.empty += 1;
        continue;
      }
      // Mêmes conventions JSONB que le miroir temps réel (Timestamp → ISO,
      // sentinelles écartées) : les lectures de secours retrouvent un
      // payload exploitable et le tri mémoire reste juste.
      const { payload } = sanitizeMirrorPayload(data);
      const row = {
        collection,
        document_id: doc.id,
        owner_id: mirrorOwnerId(payload),
        payload,
        updated_at: new Date().toISOString(),
      };
      if (!args.apply) continue;
      const { error } = await supabase
        .from("firestore_fallback")
        .upsert(row, { onConflict: "collection,document_id", ignoreDuplicates: true });
      if (error) {
        report.errors += 1;
        if (report.errors <= 5) console.warn(`  ! ${collection}/${doc.id} : ${error.message}`);
        continue;
      }
      // ignoreDuplicates : impossible de distinguer insert / skip côté SDK —
      // le bilan exact est lu en fin de course (comptage miroir).
      report.inserted += 1;
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < BATCH_SIZE) break;
  }
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!isSupabaseAdminConfigured() || !getSupabaseAdmin()) {
    fail(
      "Supabase non configuré : définissez NEXT_PUBLIC_SUPABASE_URL, " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY et SUPABASE_SERVICE_ROLE_KEY (service-role " +
        "requis pour l'écriture du miroir).",
    );
  }
  const supabase = getSupabaseAdmin()!;

  console.log("\n=== Réchauffage du miroir firestore_fallback (Task 96-c) ===");
  console.log(`Collections : ${args.collections.join(", ")}`);
  console.log(`Mode : ${args.apply ? "APPLY (écriture réelle)" : "DRY-RUN (aucune écriture)"}\n`);

  const reports = new Map<string, CollectionReport>();
  let left = args.limit;
  for (const collection of args.collections) {
    const budget = () => left;
    const report = await backfillCollection(collection, supabase, args, budget);
    left -= report.scanned;
    reports.set(collection, report);
  }

  console.log("--- Bilan par collection ---");
  let totalScanned = 0;
  let totalSeen = 0;
  for (const [collection, report] of reports) {
    console.log(
      `  ${collection} : scannés ${report.scanned} — non vides ${report.scanned - report.empty - report.errors}` +
        ` — écritures ${args.apply ? report.inserted : "prévues " + (report.scanned - report.empty)}` +
        ` — vides ${report.empty} — erreurs ${report.errors}`,
    );
    totalScanned += report.scanned;
    totalSeen += report.scanned - report.empty;
  }

  if (args.apply) {
    // Comptage de contrôle : lignes miroir désormais présentes par collection.
    for (const collection of args.collections) {
      const { count, error } = await supabase
        .from("firestore_fallback")
        .select("document_id", { count: "exact", head: true })
        .eq("collection", collection);
      if (!error) console.log(`  miroir ${collection} : ${count ?? "?"} ligne(s)`);
    }
  }

  console.log(
    `\n${args.apply ? "Réchauffage terminé — relancer est sûr (ignoreDuplicates : aucune ligne existante écrasée)." : "Dry-run terminé — relancer avec --apply pour écrire."}` +
      ` (Documents parcourus : ${totalScanned}, porteurs de données : ${totalSeen}, limite : ${args.limit === Number.MAX_SAFE_INTEGER ? "aucune" : args.limit})\n`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("Réchauffage en échec :", error);
  process.exit(1);
});
