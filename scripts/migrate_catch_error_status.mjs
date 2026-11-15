#!/usr/bin/env node
/**
 * Migration des blocs catch qui écrasent les statuts HTTP vers errorStatus().
 * Parcours par accolades équilibrées : chaque `catch (VAR) { ... }` a ses
 * `status: LITERAL` remplacés par `status: errorStatus(VAR, LITERAL)`.
 * Import ajouté si absent. Les `status: 201/200` (succès) ne sont pas touchés.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  `rg -l "requireUser|requireAdmin" app/api -g "route.ts"`,
  { encoding: "utf8", cwd: "/home/z/my-project/gen3ia" },
).trim().split("\n").filter(Boolean);

const TARGETS = new Set(["400", "401", "403", "404", "409", "429", "500", "503"]);
let patched = 0;

function findMatchingBrace(src, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

for (const file of files) {
  const path = `/home/z/my-project/gen3ia/${file}`;
  let src = readFileSync(path, "utf8");
  const before = src;

  // Traite du plus profond au plus tôt pour préserver les indices :
  // collecte d'abord tous les blocs catch, patch ensuite en ordre inverse.
  const edits = [];
  const catchRe = /catch\s*\((\w+)\)\s*\{/g;
  let m;
  while ((m = catchRe.exec(src)) !== null) {
    const varName = m[1];
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingBrace(src, openIdx);
    if (closeIdx === -1) continue;
    const block = src.slice(openIdx, closeIdx + 1);
    if (/errorStatus\s*\(/.test(block)) continue; // déjà migré
    // Remplace les statuts littéraux (hors commentaires) dans ce bloc.
    const newBlock = block.replace(
      /status:\s*(\d{3})\b(?!.*errorStatus)/g,
      (full, status) => (TARGETS.has(status) ? `status: errorStatus(${varName}, ${status})` : full),
    );
    if (newBlock !== block) edits.push([openIdx, closeIdx + 1, newBlock]);
  }

  if (edits.length === 0) continue;
  for (const [start, end, text] of edits.reverse()) {
    src = src.slice(0, start) + text + src.slice(end);
  }

  // Import errorStatus si absent.
  if (!/import\s*\{[^}]*errorStatus[^}]*\}\s*from\s*"@\/lib\/security\/http-errors"/.test(src)) {
    // Insère après la première ligne d'import (toujours en tête dans ces routes).
    const firstImport = src.match(/^import[^\n]*$/m);
    if (firstImport) {
      const idx = firstImport.index + firstImport[0].length;
      src = src.slice(0, idx) + '\nimport { errorStatus } from "@/lib/security/http-errors";' + src.slice(idx);
    }
  }

  if (src !== before) {
    writeFileSync(path, src);
    patched++;
    console.log("PATCHED", file);
  }
}
console.log(`\n${patched} fichier(s) migré(s)`);
