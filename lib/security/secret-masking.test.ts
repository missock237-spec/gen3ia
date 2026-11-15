import { describe, expect, it } from "vitest";

import { maskSecrets } from "./secret-masking";

// NOTE : les valeurs ci-dessous sont des FAUSSES credentials — jamais de
// vrais secrets dans les tests (GitHub push protection les bloquerait).
describe("maskSecrets", () => {
  it("masque une clé type OpenAI", () => {
    expect(maskSecrets("export OPENAI_API_KEY=sk-proj-fake0000fake0000fake")).toBe("export OPENAI_API_KEY=***masqué***");
    expect(maskSecrets("sk-FAKE0000FAKE0000FAKE0000")).toBe("sk-***masqué***");
  });

  it("masque un token type GitHub", () => {
    const fake = "https://ghp_FAKE0000FAKE0000FAKE@github.com/x";
    expect(maskSecrets(fake)).toContain("***masqué***");
    expect(maskSecrets(fake)).not.toContain("FAKE0000FAKE0000FAKE");
  });

  it("masque une clé AWS (exemple documenté) et un JWT factice", () => {
    expect(maskSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toBe("AWS_ACCESS_KEY_ID=AKIA***masqué***");
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKE0000FAKE0000";
    expect(maskSecrets(`token: ${fakeJwt}`)).toContain("***masqué***");
  });

  it("masque les affectations password/token/secret", () => {
    expect(maskSecrets("password=hunter2secret")).toBe("password=***masqué***");
    expect(maskSecrets("API_KEY: 'abcd1234efgh5678'")).toBe("API_KEY: ***masqué***");
    expect(maskSecrets("Authorization=Bearer abcdef123456789012345")).toContain("Bearer ***masqué***");
  });

  it("ne modifie pas un texte sans secret", () => {
    const text = "npm test\n✓ 12 tests passed\nexit 0";
    expect(maskSecrets(text)).toBe(text);
  });

  it("gère les entrées vides", () => {
    expect(maskSecrets("")).toBe("");
  });
});
