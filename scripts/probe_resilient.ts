/**
 * Sonde E2E du repli Firestore→Supabase EN CONDITIONS RÉELLES (Task 97).
 * Exécutée quand le quota Firestore de production est ÉPUISÉ (code 8 constaté) :
 * elle prouve que la couche résiliente sert et persiste via le miroir.
 * Fichier TEMPORAIRE — supprimé après la sonde, jamais commité.
 * Usage : NODE_OPTIONS=--conditions=react-server npx tsx scripts/probe_resilient.ts
 */
import { resilientCreate, resilientQuery, resilientDelete, resilientGet } from "../lib/db/firestore-fallback";
import { getQuotaGuardStats } from "../lib/db/quota-guard";

const COLLECTION = "probeFallback97";
const ID = `probe-${Date.now()}`;
const OWNER = "probe-owner-97";

async function main() {
  const results: Array<[string, boolean, string]> = [];
  const t0 = probeStartMs;
  const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
  try {
    // 1. Création résiliente : Firestore quota-mort → écriture miroir attendue
    probeStep = "create";
    log("create : départ");
    await resilientCreate(COLLECTION, ID, { userId: OWNER, label: "sonde-97", createdAt: new Date() }, OWNER);
    log("create : terminé");
    results.push(["create → miroir", true, ""]);

    // 2. Lecture ciblée : miss Firestore (quota) → miroir attendu
    probeStep = "get";
    log("get : départ");
    const got = await resilientGet<{ userId: string; label: string }>(COLLECTION, ID);
    log("get : terminé");
    results.push(["get → miroir", !!got && got.label === "sonde-97", got ? `label=${got.label}` : "null"]);

    // 3. Requête filtrée : miroir attendu
    probeStep = "query";
    log("query : départ");
    const rows = await resilientQuery<{ userId: string; label: string }>(
      COLLECTION,
      [{ field: "userId", value: OWNER }],
      { orderField: "createdAt", descending: true, includeIds: true },
    );
    const found = rows.find((r) => r.label === "sonde-97");
    log("query : terminé");
    results.push(["query filtrée → miroir", !!found, `${rows.length} ligne(s)`]);

    // 4. Suppression résiliente : purge Firestore (quota) → purge miroir
    probeStep = "delete";
    log("delete : départ");
    await resilientDelete(COLLECTION, ID);
    log("delete : terminé");
    const after = await resilientQuery<{ userId: string; label: string }>(
      COLLECTION,
      [{ field: "userId", value: OWNER }],
      { includeIds: true },
    );
    log("re-vérif : terminé");
    // L'ID de CETTE sonde doit avoir disparu (les résidus d'exécutions
    // antérieures interrompues sont purgés juste après — pas une régression).
    const ownIdGone = !after.some((row) => (row as unknown as { id?: string }).id === ID);
    results.push(["delete → purge miroir", ownIdGone, `${after.length} résidu(s) hors sonde`]);
    // Nettoyage final : purge de TOUTES les lignes de sonde (idempotent).
    for (const row of after) {
      const rowId = (row as unknown as { id?: string }).id;
      if (typeof rowId === "string") await resilientDelete(COLLECTION, rowId);
    }
    log(`nettoyage : ${after.length} résidu(s) purgé(s)`);
  } catch (error) {
    results.push(["EXCEPTION", false, error instanceof Error ? error.message : String(error)]);
  }
  console.log("=== SONDE REPLI (quota Firestore épuisé) ===");
  for (const [name, ok, info] of results) console.log(`${ok ? "PASS" : "FAIL"} — ${name}${info ? ` (${info})` : ""}`);
  console.log("disjoncteur:", JSON.stringify(getQuotaGuardStats()));
  const allPass = results.every(([, ok]) => ok);
  console.log(allPass ? "VERDICT: REPLI OPÉRATIONNEL" : "VERDICT: ÉCHEC — investiguer");
  process.exit(allPass ? 0 : 1);
}

const probeStartMs = Date.now();
let probeStep = "import";

const WATCHDOG = setTimeout(() => {
  console.error(`[WATCHDOG] ${((Date.now() - probeStartMs) / 1000).toFixed(1)}s — abort, étape bloquante: ${probeStep}`);
  process.exit(2);
}, 120_000);

main().finally(() => { clearTimeout(WATCHDOG); process.exit(0); });
