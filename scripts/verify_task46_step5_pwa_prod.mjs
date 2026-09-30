const BASE = "https://gen3ia.online";
const checks = [];
const record = (name, pass, detail = "") => { checks.push(pass); console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

const sw = await (await fetch(`${BASE}/sw.js`)).text();
record("SW : file stricte (pathname exact, startsWith supprimé)", sw.includes("QUEUED_PATHS.has(url.pathname)") && !sw.includes("startsWith(path)"));
record("SW : idempotence x-gen3ia-idempotency-key", sw.includes("x-gen3ia-idempotency-key"));
record("SW : verrou anti-doublon + plafond", sw.includes("let flushing = false") && sw.includes("MAX_ATTEMPTS = 5"));
record("SW : offline.html network-first", sw.includes("request.mode === \"navigate\"") && sw.includes("/offline.html"));
record("SW : échecs notifiés (outbox-failed)", sw.includes("gen3ia-outbox-failed"));

const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
record("Manifest : theme_color sombre", manifest.theme_color === "#05060C", manifest.theme_color);
record("Manifest : installable (icônes + standalone)", Array.isArray(manifest.icons) && manifest.display === "standalone", `${manifest.icons?.length ?? 0} icônes`);

const offline = await fetch(`${BASE}/offline.html`);
record("offline.html servi (200)", offline.status === 200, `status ${offline.status}`);

process.exit(checks.every(Boolean) ? 0 : 1);
