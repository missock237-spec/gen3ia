import { describe, expect, it } from "vitest";
import { verifyEvidence, formatEvidenceContext } from "./evidence-verifier";

describe("evidence verifier", () => {
  it("rejects unsupported source claims", () => {
    const result = verifyEvidence([{ title: "Sans preuve" }]);
    expect(result.status).toBe("insufficient");
    expect(result.evidence).toHaveLength(0);
  });

  it("keeps only usable evidence", () => {
    const result = verifyEvidence([
      { title: "Source", url: "https://example.com", snippet: "Fait documenté." },
      { title: "Incomplet", url: "https://example.com" },
    ]);
    expect(result.status).toBe("verified");
    expect(result.evidence).toHaveLength(1);
    expect(formatEvidenceContext(result)).toContain("Fait documenté.");
  });
});
