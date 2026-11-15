import { describe, expect, it } from "vitest";

/**
 * Tests du module pur W3C Trace Context (Task K) : parse tolérant de
 * traceparent, dérivation DÉTERMINISTE traceId Gen3ia → trace-id W3C,
 * émission d'en-têtes valides (nouveau span-id, flags préservés).
 */

import {
  estTraceIdGen3iaValide,
  formaterTraceparent,
  genererSpanIdW3C,
  parserTraceparent,
  traceIdGen3iaDepuisTraceparent,
  w3cTraceIdDepuisGen3ia,
} from "./trace-w3c";

const TRACE_ID_W3C = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID_W3C = "00f067aa0ba902b7";

describe("parserTraceparent", () => {
  it("accepte un traceparent valide (version 00)", () => {
    expect(parserTraceparent(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01`)).toEqual({
      traceId: TRACE_ID_W3C,
      spanId: SPAN_ID_W3C,
      flags: "01",
    });
  });

  it("normalise les majuscules et les espaces de bord", () => {
    const parse = parserTraceparent(`  00-${TRACE_ID_W3C.toUpperCase()}-${SPAN_ID_W3C.toUpperCase()}-00 `);
    expect(parse?.traceId).toBe(TRACE_ID_W3C);
    expect(parse?.flags).toBe("00");
  });

  it("accepte une version > 00 SI le format reste à 4 champs (compat W3C)", () => {
    const parse = parserTraceparent(`01-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01`);
    expect(parse?.traceId).toBe(TRACE_ID_W3C);
  });

  it("rejette les formats malformés sans lever", () => {
    expect(parserTraceparent(undefined)).toBeUndefined();
    expect(parserTraceparent(null)).toBeUndefined();
    expect(parserTraceparent("")).toBeUndefined();
    expect(parserTraceparent("pas-un-traceparent")).toBeUndefined();
    expect(parserTraceparent(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C}`)).toBeUndefined(); // 3 champs
    expect(parserTraceparent(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01-extra`)).toBeUndefined(); // 5 champs
  });

  it("rejette les champs invalides (zéros, longueur, version ff)", () => {
    expect(parserTraceparent(`00-${"0".repeat(32)}-${SPAN_ID_W3C}-01`)).toBeUndefined(); // trace-id zéro
    expect(parserTraceparent(`00-${TRACE_ID_W3C}-${"0".repeat(16)}-01`)).toBeUndefined(); // span-id zéro
    expect(parserTraceparent(`00-${"x".repeat(32)}-${SPAN_ID_W3C}-01`)).toBeUndefined(); // pas hex
    expect(parserTraceparent(`00-${TRACE_ID_W3C.slice(0, 31)}-${SPAN_ID_W3C}-01`)).toBeUndefined(); // 31 hex
    expect(parserTraceparent(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C.slice(0, 15)}-01`)).toBeUndefined(); // 15 hex
    expect(parserTraceparent(`ff-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01`)).toBeUndefined(); // version interdite
    expect(parserTraceparent(`0-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01`)).toBeUndefined(); // version 1 hex
    expect(parserTraceparent(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-0z`)).toBeUndefined(); // flags invalides
  });
});

describe("traceIdGen3iaDepuisTraceparent", () => {
  it("extrait le trace-id W3C comme traceId Gen3ia (32 hex valides)", () => {
    expect(traceIdGen3iaDepuisTraceparent(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01`)).toBe(TRACE_ID_W3C);
  });

  it("traceparent malformé → undefined (jamais de traceId douteux)", () => {
    expect(traceIdGen3iaDepuisTraceparent("garbage")).toBeUndefined();
  });
});

describe("w3cTraceIdDepuisGen3ia — dérivation déterministe", () => {
  it("traceId déjà en 32 hex minuscules → identité (pas de dérivation)", () => {
    expect(w3cTraceIdDepuisGen3ia(TRACE_ID_W3C)).toBe(TRACE_ID_W3C);
  });

  it("traceId Gen3ia arbitraire → 128 bits hex déterministe et distinct", () => {
    const derive1 = w3cTraceIdDepuisGen3ia("trc_abc123-def456");
    const derive2 = w3cTraceIdDepuisGen3ia("trc_abc123-def456");
    expect(derive1).toBe(derive2);
    expect(derive1).toMatch(/^[0-9a-f]{32}$/);
    expect(derive1).not.toMatch(/^0+$/);
    // Deux identifiants distincts → deux traces W3C distinctes.
    expect(derive1).not.toBe(w3cTraceIdDepuisGen3ia("trc_autre-trace"));
    // La dérivation n'est pas l'identité (l'entrée n'était pas du 32 hex).
    expect(derive1).not.toBe("trc_abc123-def456");
  });

  it("majuscules 32 hex : l'identité exige des minuscules (spec W3C)", () => {
    // Les majuscules ne sont PAS acceptées telles quelles : dérivation.
    expect(w3cTraceIdDepuisGen3ia(TRACE_ID_W3C.toUpperCase())).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("formaterTraceparent", () => {
  it("produit un en-tête complet valide avec span-id NOUVEAU par défaut", () => {
    const traceparent = formaterTraceparent("trc_gen3ia-42");
    const parties = traceparent.split("-");
    expect(parties).toHaveLength(4);
    expect(parties[0]).toBe("00");
    expect(parties[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(parties[2]).toMatch(/^[0-9a-f]{16}$/);
    expect(parties[3]).toBe("01");
    // Deux émissions → deux span-id distincts (même arbre, sauts distincts).
    expect(parties[2]).not.toBe(formaterTraceparent("trc_gen3ia-42").split("-")[2]);
  });

  it("préserve les flags entrants et accepte un span-id imposé (tests)", () => {
    const traceparent = formaterTraceparent(TRACE_ID_W3C, { spanId: SPAN_ID_W3C, flags: "00" });
    expect(traceparent).toBe(`00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-00`);
  });

  it("span-id/flags imposés invalides → remplacés par des valeurs saines", () => {
    const traceparent = formaterTraceparent(TRACE_ID_W3C, { spanId: "court", flags: "zz" });
    const parties = traceparent.split("-");
    expect(parties[2]).toMatch(/^[0-9a-f]{16}$/);
    expect(parties[3]).toBe("01");
  });
});

describe("genererSpanIdW3C", () => {
  it("16 hexadécimales minuscules, unique sur deux appels", () => {
    const span1 = genererSpanIdW3C();
    const span2 = genererSpanIdW3C();
    expect(span1).toMatch(/^[0-9a-f]{16}$/);
    expect(span2).toMatch(/^[0-9a-f]{16}$/);
    expect(span1).not.toBe(span2);
  });
});

describe("estTraceIdGen3iaValide", () => {
  it("grammaire partagée anti-injection (8..64 alphanumériques, tirets, underscores)", () => {
    expect(estTraceIdGen3iaValide("trc_abc123")).toBe(true);
    expect(estTraceIdGen3iaValide(TRACE_ID_W3C)).toBe(true);
    expect(estTraceIdGen3iaValide("court")).toBe(false); // < 8
    expect(estTraceIdGen3iaValide("a".repeat(65))).toBe(false); // > 64
    expect(estTraceIdGen3iaValide("injection\nmalveillante")).toBe(false);
    expect(estTraceIdGen3iaValide("espaces interdits")).toBe(false);
    expect(estTraceIdGen3iaValide("")).toBe(false);
    expect(estTraceIdGen3iaValide(null)).toBe(false);
    expect(estTraceIdGen3iaValide(undefined)).toBe(false);
  });
});
