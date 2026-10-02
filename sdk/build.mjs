#!/usr/bin/env node
/**
 * Build du SDK @gen3ia/sdk (Task 61).
 *
 * Trois passes tsc, dans cet ordre :
 *  1) typecheck de référence (noEmit, options strictes) — échoue AVANT toute
 *     émission avec des messages propres ;
 *  2) émission ESM (module es2022) dans dist/esm — consommée par `import` ;
 *  3) émission CJS (module node16, package.json sans « type » → CommonJS)
 *     dans dist/cjs — consommée par `require`.
 *
 * Les manifestes runtime dist/{esm,cjs}/package.json sont écrits ensuite :
 * Node détermine le format d'un fichier .js par le champ « type » du
 * package.json le plus proche — sans lui, dist/esm/*.js (syntaxe import)
 * serait interprété CommonJS et casserait au require/import réel.
 *
 * Usage : npm run sdk:build (racine) — typescript vient des devDependencies
 * racines (pas de node_modules dédié dans sdk/, dépendance zéro assumée).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = join(repoRoot, "sdk");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function runTsc(project) {
  execFileSync(process.execPath, [tscBin, "-p", project], { stdio: "inherit", cwd: repoRoot });
}

// 1) Typecheck de référence (noEmit strict du tsconfig de base).
runTsc(join(sdkDir, "tsconfig.json"));

// 2) + 3) Double émission ESM / CJS.
runTsc(join(sdkDir, "tsconfig.esm.json"));
runTsc(join(sdkDir, "tsconfig.cjs.json"));

writeFileSync(join(sdkDir, "dist", "esm", "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
writeFileSync(join(sdkDir, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");

console.log("[sdk] build OK — dist/esm (import) + dist/cjs (require) émis.");
