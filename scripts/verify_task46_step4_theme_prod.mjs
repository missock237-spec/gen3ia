const BASE = "https://gen3ia.online";
const home = await fetch(`${BASE}/`);
const html = await home.text();
const cssUrls = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
let allCss = "";
for (const url of cssUrls.slice(0, 5)) {
  const res = await fetch(url.startsWith("http") ? url : `${BASE}${url}`);
  allCss += await res.text();
}
// Le minifieur échappe le sélecteur d'attribut : [class\*=--g3-gradient].
const hasGradientExemption = allCss.includes("[class*=--g3-gradient") || allCss.includes('[class*="--g3-gradient"]');
const checks = [
  ["CSS servi (au moins 1 feuille)", cssUrls.length > 0, `${cssUrls.length} feuilles`],
  ["Couche sombre : pastels → tokens", allCss.includes(".bg-emerald-50"), ""],
  ["Token success-soft présent", allCss.includes("--g3-success-soft"), ""],
  ["Exemption dégradés --g3-gradient", hasGradientExemption, ""],
  ["hover:text-white converti en clair", allCss.includes("hover\\:text-white:hover"), ""],
];
let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
