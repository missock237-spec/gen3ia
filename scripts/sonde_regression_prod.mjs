#!/usr/bin/env node
/**
 * Sonde de régression production — Job 478451
 * Vérifie les 10 endpoints critiques + version.json (gitSha / buildDate).
 * Usage: node scripts/sonde_regression_prod.mjs
 */
const BASE = 'https://gen3ia.online';
const ENDPOINTS = [
  ['health', '/api/health'],
  ['accueil', '/'],
  ['chat', '/chat'],
  ['dashboard', '/dashboard'],
  ['security.txt', '/.well-known/security.txt'],
  ['apple-touch-icon', '/apple-touch-icon.png'],
  ['sitemap', '/sitemap.xml'],
  ['robots', '/robots.txt'],
  ['llms.txt', '/llms.txt'],
  ['login', '/login'],
];

const t0 = Date.now();
async function probe(name, path) {
  const s = Date.now();
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(BASE + path, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'sonde-478451/1.0 (regression)' },
      redirect: 'manual',
    });
    clearTimeout(to);
    const ms = Date.now() - s;
    // 2xx/3xx/401 considérés "service rendu" (401 = page protégée qui répond)
    const ok = (r.status >= 200 && r.status < 400) || r.status === 401;
    return { name, path, status: r.status, ms, ok, ttfb: ms };
  } catch (e) {
    return { name, path, status: 'ERR', ms: Date.now() - s, ok: false, err: String(e).slice(0, 80) };
  }
}

const results = [];
for (const [name, path] of ENDPOINTS) results.push(await probe(name, path));

// version.json avec cache-buster
let vj = null;
try {
  const r = await fetch(`${BASE}/version.json?rm=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  vj = await r.json();
} catch (e) { vj = { error: String(e).slice(0, 80) }; }

console.log('=== SONDE RÉGRESSION PROD —', new Date().toISOString(), '===');
let nok = 0;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(18)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)} ms${r.err ? '  ' + r.err : ''}`);
  if (r.ok) nok++;
}
console.log(`\nEndpoints OK: ${nok}/${ENDPOINTS.length}`);
console.log('version.json:', JSON.stringify(vj));
console.log(`Durée totale: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(nok === ENDPOINTS.length ? 0 : 1);
