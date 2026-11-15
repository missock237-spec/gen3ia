#!/usr/bin/env node
/**
 * Détection : routes API qui appellent requireUser/requireAdmin mais dont le
 * catch final renvoie un statut littéral (écrase 403 CSRF / 401 auth / 503
 * infra vers 400 ou 500). Ces routes doivent migrer vers errorStatus().
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  `rg -l "requireUser|requireAdmin" app/api -g "route.ts"`,
  { encoding: "utf8", cwd: "/home/z/my-project/gen3ia" },
).trim().split("\n").filter(Boolean);

const suspects = [];
for (const file of files) {
  const src = readFileSync(`/home/z/my-project/gen3ia/${file}`, "utf8");
  // La route importe-t-elle déjà errorStatus ?
  const usesErrorStatus = /errorStatus\s*\(/.test(src);
  if (usesErrorStatus) continue;
  // Catch avec statut littéral ?
  const literalCatch = /\}\s*catch\s*\((\w+)\)\s*\{[\s\S]{0,600}?status:\s*(400|401|403|404|500|409)\b/.test(src);
  if (literalCatch) suspects.push(file);
}
console.log(`${suspects.length} route(s) suspecte(s) :`);
for (const s of suspects) console.log(" -", s);
