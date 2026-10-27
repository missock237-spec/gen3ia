import { describe, expect, it } from "vitest";

import {
  CHAMP_TOKEN_HASH,
  estDue,
  genererTokenDeclencheur,
  hacherToken,
  parserIntervale,
  signerCorps,
  tokenBienForme,
  verifierSignatureCorps,
} from "@/lib/workflows/triggers";

describe("déclencheurs webhook/cron des workflows (P2)", () => {
  it("génère des tokens bien formés et distincts", () => {
    const a = genererTokenDeclencheur();
    const b = genererTokenDeclencheur();
    expect(a).toMatch(/^gwtr_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(tokenBienForme(a)).toBe(true);
    expect(tokenBienForme("gwtr_court")).toBe(false);
    expect(tokenBienForme("autre_format")).toBe(false);
  });

  it("hache le token de façon stable (valeur Firestore = hash, jamais le token)", () => {
    const token = genererTokenDeclencheur();
    const h1 = hacherToken(token);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hacherToken(token)).toBe(h1);
    expect(hacherToken("autre")).not.toBe(h1);
    expect(CHAMP_TOKEN_HASH).toBe("triggerTokenHash");
  });

  it("signe et vérifie le corps de webhook en temps constant", () => {
    const secret = "secret-test-rotation";
    const corps = JSON.stringify({ input: { client: "ACME" } });
    const signature = signerCorps(corps, secret);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifierSignatureCorps(corps, secret, signature)).toBe(true);
    expect(verifierSignatureCorps(corps, secret, "sha256=faux")).toBe(false);
    expect(verifierSignatureCorps(`${corps} `, secret, signature)).toBe(false);
    expect(verifierSignatureCorps(corps, "autre-secret", signature)).toBe(false);
    expect(verifierSignatureCorps(corps, secret, null)).toBe(false);
  });

  it("parse l'intervalle cron — bornes 5..1440 minutes", () => {
    expect(parserIntervale(30)).toBe(30);
    expect(parserIntervale(5)).toBe(5);
    expect(parserIntervale(1440)).toBe(1440);
    expect(parserIntervale(4)).toBeNull();
    expect(parserIntervale(1441)).toBeNull();
    expect(parserIntervale(7.9)).toBe(7);
    expect(parserIntervale("30")).toBeNull();
    expect(parserIntervale(undefined)).toBeNull();
    expect(parserIntervale(Infinity)).toBeNull();
  });

  it("calcule l'échéance due (jamais déclenché = dû ; marge 15 s)", () => {
    const maintenant = 1_700_000_000_000;
    expect(estDue(30, undefined, maintenant)).toBe(true);
    expect(estDue(30, null, maintenant)).toBe(true);
    // Déclenché il y a 31 min → dû (30 min écoulées + marge).
    expect(estDue(30, maintenant - 31 * 60_000, maintenant)).toBe(true);
    // Déclenché il y a exactement 30 min − 20 s → PAS dû (hors marge).
    expect(estDue(30, maintenant - (30 * 60_000 - 20_000), maintenant)).toBe(false);
    // Déclenché il y a 29 min + 50 s → dû (dans la marge de 15 s).
    expect(estDue(30, maintenant - (29 * 60_000 + 50_000), maintenant)).toBe(true);
  });
});
