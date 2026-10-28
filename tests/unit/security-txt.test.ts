import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Itération 16 Job 478451 — /.well-known/security.txt (RFC 9116).
 * Garde-fous : la politique de divulgation responsable (bug bounty,
 * docs/securite/bug-bounty.md) doit être découverte par les chercheurs
 * via l'URL standard .well-known, et rester conforme dans le temps
 * (champ Expires obligatoire, re-expiré avant péremption).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("security.txt (RFC 9116) — divulgation responsable découvrable", () => {
  const txt = read("public/.well-known/security.txt");

  it("champs obligatoires Contact + Expires présents", () => {
    expect(txt).toMatch(/^Contact:\s*mailto:security@gen3ia\.online$/m);
    expect(txt).toMatch(/^Expires:\s*\S+/m);
  });

  it("contact aligné sur la politique bug-bounty documentée", () => {
    const bounty = read("docs/securite/bug-bounty.md");
    expect(bounty).toContain("security@gen3ia.online");
  });

  it("Expires est une date ISO 8601 UTC valide et future", () => {
    const match = txt.match(/^Expires:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const expires = new Date(match![1].trim());
    expect(expires.toString()).not.toBe("Invalid Date");
    expect(expires.getTime()).toBeGreaterThan(Date.now());
  });

  it("canonical, langues et politique présents et cohérents", () => {
    expect(txt).toMatch(/^Canonical:\s*https:\/\/gen3ia\.online\/\.well-known\/security\.txt$/m);
    expect(txt).toMatch(/^Preferred-Languages:\s*.*fr.*$/m);
    expect(txt).toMatch(/^Policy:\s*https:\/\/github\.com\/missock237-spec\/gen3ia\/blob\/main\/docs\/securite\/bug-bounty\.md$/m);
  });
});
