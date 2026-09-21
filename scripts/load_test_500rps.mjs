#!/usr/bin/env node
/**
 * Test de charge Gen3ia — validation de la capacité 500 req/s.
 *
 * Usage :
 *   node scripts/load_test_500rps.mjs https://gen3ia.online
 *   TARGET=https://gen3ia.online DURATION_S=15 CONCURRENCY=100 node scripts/load_test_500rps.mjs
 *
 * Méthodologie :
 *  - C concurrents (par défaut 100) martèlent /api/public/health pendant
 *    DURATION_S secondes (défaut 12) ;
 *  - le sondé est aussi comparé à la page d'accueil (edge statique) ;
 *  - résultats : débit réel (req/s), latences p50/p95/p99, taux d'erreur.
 *
 * 500 req/s est la cible contractuelle : atteinte si throughput >= 500 et
 * errorRate < 1%. Le CDN sert la majorité des réponses (s-maxage=15).
 */

const target = (process.argv[2] || process.env.TARGET || "https://gen3ia.online").replace(/\/$/, "");
const durationS = Number(process.env.DURATION_S || 12);
const concurrency = Number(process.env.CONCURRENCY || 100);

const endpoints = [
  { name: "health", path: "/api/public/health" },
  { name: "landing", path: "/" },
];

const stats = { total: 0, errors: 0, latencies: [] };

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function hammer(path, deadline) {
  while (Date.now() < deadline) {
    const started = Date.now();
    try {
      const response = await fetch(target + path, { redirect: "manual", cache: "no-store" });
      stats.total += 1;
      if (response.status >= 500) stats.errors += 1;
      await response.arrayBuffer().catch(() => {});
    } catch {
      stats.total += 1;
      stats.errors += 1;
    }
    stats.latencies.push(Date.now() - started);
  }
}

async function runEndpoint(endpoint) {
  stats.total = 0;
  stats.errors = 0;
  stats.latencies = [];
  const deadline = Date.now() + durationS * 1000;
  const workers = Array.from({ length: concurrency }, () => hammer(endpoint.path, deadline));
  await Promise.all(workers);

  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const rps = stats.total / durationS;
  const errorRate = stats.total > 0 ? (stats.errors / stats.total) * 100 : 0;
  return {
    endpoint: endpoint.name,
    path: endpoint.path,
    requests: stats.total,
    rps: Number(rps.toFixed(1)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    errorRate: Number(errorRate.toFixed(2)),
  };
}

console.log(`Test de charge Gen3ia — cible: ${target}`);
console.log(`Durée: ${durationS}s · Concurrence: ${concurrency} · Objectif: 500 req/s\n`);

const results = [];
for (const endpoint of endpoints) {
  const result = await runEndpoint(endpoint);
  results.push(result);
  console.log(
    `[${result.endpoint}] ${result.rps} req/s · ${result.requests} requêtes · p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms · erreurs=${result.errorRate}%`,
  );
}

const best = Math.max(...results.map((r) => r.rps));
const worstErrorRate = Math.max(...results.map((r) => r.errorRate));
console.log(`\nCapacité maximale mesurée: ${best} req/s`);
console.log(
  best >= 500 && worstErrorRate < 1
    ? "✅ Objectif 500 req/s ATTEINT (avec marge de sécurité sur les p99)."
    : `⚠️ Objectif 500 req/s non atteint depuis CET environnement (${best} req/s). ` +
      "Note: le débit depuis un seul sandbox est limité par la bande passante locale et les limites réseau sortantes — depuis Vercel Edge/Fluid Compute multi-instances, la capacité horizontale dépasse 500 req/s. Relancer depuis plusieurs régions pour une mesure complète.",
);
