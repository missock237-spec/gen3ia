#!/usr/bin/env node
/**
 * Codemod — migration des catch blocks `{ status: 500 }` codé en dur vers
 * `errorStatus(error, 500)` (lib/security/http-errors.ts), pour que :
 *  - une absence de session renvoie 401 (pas 500) ;
 *  - une panne Firestore/provider renvoie 503 (pas 500 générique).
 * Chirurgical : ne touche QUE les lignes exactes `error instanceof Error ? error.message`
 * suivies d'un statut littéral. Insère l'import s'il manque.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  `rg -l "error instanceof Error \\? error.message" app/api -g "route.ts"`,
  { encoding: "utf8", cwd: "/home/z/my-project/gen3ia" },
).trim().split("\n").filter(Boolean);

let changed = 0;
for (const file of files) {
  const path = `/home/z/my-project/gen3ia/${file}`;
  let src = readFileSync(path, "utf8");
  const before = src;

  // 1) Pattern mono-ligne : `{ error: error instanceof Error ? error.message : "X" }, { status: NNN }`
  src = src.replace(
    /\{ (error|ok: false, error): error instanceof Error \? error\.message : ("(?:[^"\\]|\\.)*") \}, \{ status: (500|400|404|409) \}/g,
    (_m, key, msg, status) => `{ ${key}: error instanceof Error ? error.message : ${msg} }, { status: errorStatus(error, ${status}) }`,
  );

  // 2) Pattern multi-ligne (payload objet puis statut sur la ligne suivante)
  src = src.replace(
    /(\{\s*(?:error|ok: false, error): error instanceof Error \? error\.message : "(?:[^"\\]|\\.)*",?\s*\n?\s*\},\s*\{\s*status:\s*)(500|400|404|409)(\s*\})/g,
    (_m, head, status, tail) => `${head}errorStatus(error, ${status})${tail}`,
  );

  if (src !== before) {
    // 3) Import errorStatus s'il manque (errorBody est déjà importé dans certaines routes).
    if (!/import \{[^}]*errorStatus[^}]*\} from "@\/lib\/security\/http-errors"/.test(src)) {
      if (/import \{ errorBody[^}]*\} from "@\/lib\/security\/http-errors";/.test(src)) {
        src = src.replace(
          /import \{ errorBody/,
          "import { errorBody, errorStatus",
        );
        src = src.replace(/import \{ errorBody, errorBody, errorStatus/, "import { errorBody, errorStatus");
      } else {
        // insère après la dernière import @/lib/… existante ou après la première ligne d'import
        const importLines = [...src.matchAll(/^import .*$/gm)];
        if (importLines.length) {
          const last = importLines[importLines.length - 1];
          const idx = last.index + last[0].length;
          src = src.slice(0, idx) + '\nimport { errorStatus } from "@/lib/security/http-errors";' + src.slice(idx);
        }
      }
    }
    writeFileSync(path, src);
    changed++;
    console.log("PATCHED", file);
  }
}
console.log(`\n${changed} fichier(s) modifié(s)`);
