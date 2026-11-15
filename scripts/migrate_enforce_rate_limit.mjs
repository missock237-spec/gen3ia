/**
 * Migration : rateLimit (mémoire seule) → enforceRateLimit (local + Redis distribué).
 * - Remplace les appels `rateLimit(` par `await enforceRateLimit(` dans app/api.
 * - Corrige les imports en conservant clientIp / autres symboles.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  "rg -l 'from \"@/lib/security/rate-limit\"' app --type ts",
  { cwd: "/home/z/my-project/gen3ia", encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

let changedFiles = 0;
for (const file of files) {
  const path = `/home/z/my-project/gen3ia/${file}`;
  let src = readFileSync(path, "utf8");
  const original = src;

  // 1. Appels : `rateLimit(` → `await enforceRateLimit(` (frontière de mot :
  // rateLimitDistributed( n'est pas touché car suivi de `D` et non de `(`).
  src = src.replace(/\brateLimit\(/g, "await enforceRateLimit(");

  // 2. Imports nommés : ajouter enforceRateLimit, retirer rateLimit si
  // devenu inutilisé, conserver clientIp et autres symboles.
  src = src.replace(
    /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/security\/rate-limit["'];?/g,
    (full, names) => {
      const list = names
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const cleaned = list.filter(n => n !== "rateLimit" && n !== "enforceRateLimit");
      const keepSet = new Set(cleaned);
      keepSet.add("enforceRateLimit");
      return `import { ${[...keepSet].join(", ")} } from "@/lib/security/rate-limit";`;
    },
  );

  if (src !== original) {
    writeFileSync(path, src);
    changedFiles += 1;
    console.log(`migré: ${file}`);
  }
}
console.log(`\n${changedFiles} fichier(s) migré(s).`);
