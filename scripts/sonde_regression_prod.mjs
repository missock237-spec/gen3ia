#!/usr/bin/env node
/**
 * Sonde de régression production — Job 478451
 * Vérifie les 13 endpoints critiques + version.json (gitSha / buildDate).
 * it.74 : /mobile (SNN embarqué téléphone), /api/energie (profil actif +
 * compteur réel de fenêtres évitées/exécutées — structure déclarée) et le
 * snapshot téléphone (magie G3TEL73 + taille ≥ 1,5 Mo).
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
  // it.73/74 — SNN embarqué (page publique téléphone) + sobriété déclarée.
  // Parité verrouillée avec la sonde de surveillance (mêmes endpoints).
  // Le snapshot binaire (1,5 Mo) reste une validation spécialisée ci-dessous
  // (poussée dans les résultats sans figurer dans la liste commune).
  ['mobile', '/mobile'],
  ['api-energie', '/api/energie'],
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

// --- Fenêtre PULL : le build servi ≠ main → un 404 sur un endpoint NOUVEAU
// du build courant est un état de livraison CONNU (poller ≤ ~21 min), pas
// une régression. Une fois le build à jour, un 404 redevient un échec.
let vj = null;
try {
  const r = await fetch(`${BASE}/version.json?rm=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  vj = await r.json();
} catch (e) { vj = { error: String(e).slice(0, 80) }; }
let shaM = null;
try {
  const r = await fetch('https://api.github.com/repos/missock237-spec/gen3ia/commits/main', { headers: { 'user-agent': 'sonde-478451/1.0 (regression)' } });
  if (r.ok) shaM = (await r.json())?.sha ?? null;
} catch { shaM = null; }
const lagSha = Boolean(shaM && vj?.gitSha && !shaM.startsWith(vj.gitSha));
if (lagSha) {
  const er = results.find((r) => r.name === 'api-energie');
  if (er && !er.ok && er.status === 404) {
    er.ok = true;
    er.detail = `en attente de basculement PULL (build servi ${vj.gitSha?.slice(0, 8)} ≠ main ${shaM.slice(0, 8)})`;
  }
}

// --- Validations spécialisées it.74 (structure, pas de valeur figée) ---
// /api/energie : structure déclarée complète (profil actif ∈ ensemble,
// source ∈ ensemble, compteur = entiers ≥ 0 + horodatage ISO).
try {
  const er = results.find((r) => r.name === 'api-energie');
  const r = await fetch(`${BASE}/api/energie?rm=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  const j = await r.json();
  const profils = ['plein', 'eco', 'telephone'];
  const sources = ['env', 'fichier-versionne', 'defaut-honnete'];
  const c = j.compteur ?? {};
  const structureOK =
    profils.includes(j.profil?.actif) &&
    sources.includes(j.profil?.source) &&
    typeof j.profil?.description === 'string' && j.profil.description.length > 10 &&
    Number.isInteger(c.fenetresExecutees) && c.fenetresExecutees >= 0 &&
    Number.isInteger(c.fenetresEvitees) && c.fenetresEvitees >= 0 &&
    Number.isInteger(c.epoquesRPIAEvitees) && c.epoquesRPIAEvitees >= 0 &&
    Number.isInteger(c.cyclesNoyauEvites) && c.cyclesNoyauEvites >= 0 &&
    /^\d{4}-\d{2}-\d{2}T/.test(String(c.demarrageIso ?? '')) &&
    typeof j.honnetete?.regle === 'string';
  if (structureOK) {
    er.detail = `profil=${j.profil.actif} source=${j.profil.source} evitees=${c.fenetresEvitees} executees=${c.fenetresExecutees}`;
  } else {
    er.ok = false; er.err = 'structure /api/energie incomplète';
  }
} catch (e) { /* déjà compté par probe */ }

// Snapshot téléphone : magie G3TEL73 (8 octets, dernier nul) + taille ≥ 1,5 Mo
// (validation spécialisée — poussée dans les résultats, hors liste commune).
try {
  const s = Date.now();
  const r = await fetch(`${BASE}/neural/cortex-telephone-it73.bin?rm=${Date.now()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const magieOK = buf.slice(0, 7).toString('ascii') === 'G3TEL73' && buf[7] === 0;
  const tailleOK = buf.length >= 1_500_000;
  results.push({
    name: 'snapshot-telephone',
    path: '/neural/cortex-telephone-it73.bin',
    status: r.status,
    ms: Date.now() - s,
    ok: r.status === 200 && magieOK && tailleOK,
    detail: magieOK && tailleOK ? `${(buf.length / 1_048_576).toFixed(2)} Mo, magie OK` : `magie=${magieOK} taille=${buf.length}o`,
    err: r.status !== 200 ? `HTTP ${r.status}` : !(magieOK && tailleOK) ? 'snapshot invalide' : '',
  });
} catch (e) {
  results.push({ name: 'snapshot-telephone', path: '/neural/cortex-telephone-it73.bin', status: 'ERR', ms: 0, ok: false, err: String(e).slice(0, 80) });
}

// version.json déjà relevé ci-dessus (fenêtre PULL)

console.log('=== SONDE RÉGRESSION PROD —', new Date().toISOString(), '===');
let nok = 0;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(18)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)} ms${r.detail ? '  ' + r.detail : ''}${r.err ? '  ' + r.err : ''}`);
  if (r.ok) nok++;
}
console.log(`\nEndpoints OK: ${nok}/${results.length} (liste commune ${ENDPOINTS.length} + validations spécialisées)`);
console.log('version.json:', JSON.stringify(vj));
console.log(`Durée totale: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(nok === results.length ? 0 : 1);
