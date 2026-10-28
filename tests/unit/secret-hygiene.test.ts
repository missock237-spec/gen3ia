import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Itération 18 Job 478451 — garde-fou anti-fuite de secrets dans l'arbre
 * source (complément local de gitleaks CI + hook pre-commit).
 *
 * Doctrine .gitleaks.toml :
 *  - la clé Firebase Web (AIza…) est PUBLIQUE PAR CONCEPTION (NEXT_PUBLIC_*)
 *    : identifiant de projet, protégé par règles de sécurité / domaines ;
 *  - les fixtures des modules de masquage (secret-masking, config-report)
 *    contiennent des faux ÉVIDENTS, exclus par path dans la CI gitleaks.
 *
 * Ce test scanne l'arbre avec des motifs HAUTE CONFIANCE uniquement
 * (formats exacts fournisseurs + PEM complet avec END) et exclut les
 * mêmes allowlist que la CI, pour zéro faux positif toléré.
 */

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "docs", "datasets", "public",
  ".vercel", "coverage", "gen3-agent", "sdk", "worklets",
]);

/** Extensions scannées (texte/Code) — les binaires sont ignorés. */
const SCAN_EXT = new Set([
  ".ts", ".tsx", ".js", ".cjs", ".mjs", ".json", ".md", ".toml", ".yaml",
  ".yml", ".sh", ".py", ".html", ".css", ".txt",
]);

/** Fichiers allowlistés CI gitleaks (fixtures documentées de faux). */
const ALLOWED_FILES = new Set([
  "lib/security/secret-masking.test.ts",
  "lib/env/config-report.test.ts",
  "lib/integrations/custom-apis/client.test.ts",
  "app/api/settings/api-keys/route.test.ts",
  "lib/queue/tick-queue.test.ts",
  "lib/memory/keyvalue.test.ts",
  "scripts/e2e_cycle03_prod.mjs",
  ".gitleaks.toml",
  "package-lock.json",
]);

const HIGH_CONFIDENCE: Array<[string, RegExp]> = [
  ["token GitHub ghp_", /ghp_[A-Za-z0-9]{36}/],
  ["token GitHub gho_", /gho_[A-Za-z0-9]{36}/],
  ["token GitHub fin_ (fine-grained)", /github_pat_[A-Za-z0-9_]{40,}/],
  ["clé AWS AKIA", /AKIA[0-9A-Z]{16}/],
  ["token Hugging Face", /hf_[A-Za-z0-9]{34}/],
  ["token Slack", /xox[bapr]-[A-Za-z0-9-]{10,}/],
  ["clé OpenAI sk-proj-", /sk-proj-[A-Za-z0-9_-]{40,}/],
  // PEM COMPLET : en-tête + corps ≥ 1 ligne base64 + END (les fixtures à
  // header seul de 27 caractères, sans corps ni END, ne matchent pas).
  ["clé privée PEM complète", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{80,}?-----END [A-Z ]*PRIVATE KEY-----/],
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

describe("Hygiène secrets — arbre source sans fuite haute confiance", () => {
  it("aucun format de secret fournisseur dans les fichiers scannés", () => {
    const fuites: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWED_FILES.has(rel)) continue;
      let content: string;
      try {
        if (statSync(file).size > 2_000_000) continue;
        content = readFileSync(file, "utf8");
      } catch {
        continue; // binaire ou illisible : hors périmètre du scan texte
      }
      for (const [label, rx] of HIGH_CONFIDENCE) {
        if (rx.test(content)) fuites.push(`${rel} → ${label}`);
      }
    }
    expect(
      fuites,
      `secrets détectés (révoquer + purger) :\n${fuites.join("\n")}`,
    ).toEqual([]);
  });

  it("l'allowlist CI reste alignée : chaque fichier exclu existe", () => {
    for (const rel of ALLOWED_FILES) {
      if (rel === "package-lock.json") continue;
      expect(
        statSync(path.join(ROOT, rel), { throwIfNoEntry: false })?.isFile?.() ?? false,
        `allowlist désynchronisée : ${rel} n'existe plus`,
      ).toBe(true);
    }
  });
});
