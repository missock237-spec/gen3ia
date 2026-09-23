/**
 * Test réel de la cascade de recherche (hors registry) :
 * DuckDuckGo → Wikipédia. Usage : node --experimental-strip-types ? Non,
 * ce fichier est exécuté via tsx : npx tsx scripts/diag_search_cascade.ts
 */
import { searchDuckDuckGo, searchWikipedia, searchWeb } from "../lib/tools/web/search";

async function main() {
  const query = "intelligence artificielle Afrique 2026";
  console.log("— DuckDuckGo direct :");
  try {
    const ddg = await searchDuckDuckGo(query, 3);
    console.log(`  OK, ${ddg.results.length} résultat(s) ; 1er : ${ddg.results[0]?.title} → ${ddg.results[0]?.url.slice(0, 80)}`);
  } catch (error) {
    console.log(`  Échec attendu possible : ${error instanceof Error ? error.message : error}`);
  }

  console.log("— Wikipédia direct :");
  const wiki = await searchWikipedia(query, 3);
  console.log(`  OK, ${wiki.results.length} résultat(s) ; 1er : ${wiki.results[0]?.title} → ${wiki.results[0]?.url.slice(0, 80)}`);

  console.log("— Cascade complète (searchWeb) :");
  const cascade = await searchWeb(query, 5);
  console.log(`  OK, ${cascade.length} résultat(s) ; source du 1er : ${cascade[0]?.source ?? "moteur principal"}`);
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});
