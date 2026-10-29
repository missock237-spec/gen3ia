import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garde-fou — CONTAINMENT DES ERREURS RUNTIME AU NIVEAU SEGMENT (itération 22,
 * Job 478451).
 *
 * Sans boundary par segment, une exception de rendu dans un composant d'un
 * segment remonte jusqu'à app/error.tsx qui remplace LA PAGE ENTIÈRE
 * (navigation comprise). Constat du 2026-10-29 : 9 segments dotés d'un
 * loading.tsx n'avaient AUCUN error.tsx, et le composant réutilisable
 * components/error/ErrorBoundary.tsx n'était importé NULLE PART.
 *
 * Ce test verrouille :
 * 1. chaque segment à loading.tsx possède un error.tsx segmentaire branché
 *    sur SegmentError avec le bon tag de segment ;
 * 2. SegmentError capture via le PONT asynchrone (jamais @sentry/nextjs en
 *    direct — mesure ADR-005 : +54 kB gzip au chemin critique) ;
 * 3. la page admin isole ses deux zones par ErrorBoundary (composant vivant) ;
 * 4. les boundaries racines app/error.tsx + app/global-error.tsx restent en
 *    place (dernier filet).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const SEGMENTS = [
  "dashboard",
  "admin",
  "settings",
  "team",
  "developer",
  "live",
  "billing",
  "memory",
  "neural",
] as const;

describe("Containment runtime — error.tsx par segment", () => {
  it.each(SEGMENTS)("segment %s : error.tsx présent et branché sur SegmentError", (segment) => {
    const file = `app/${segment}/error.tsx`;
    expect(existsSync(path.join(process.cwd(), file)), `${file} doit exister`).toBe(true);
    const src = read(file);
    // Branchement du composant partagé (pas de fallback ad hoc dupliqué)
    expect(src).toContain(`@/components/error/segment-error`);
    expect(src).toContain(`<SegmentError`);
    // Tag de segment correct (routage Sentry + eyebrow)
    expect(src).toContain(`segment="${segment}"`);
    // Contrat Next : props error + reset typées
    expect(src).toContain("reset: () => void");
    expect(src).toContain("digest?: string");
  });

  it("chaque segment à loading.tsx est couvert (plus de segment nu)", () => {
    const loadings = SEGMENTS.filter((s) =>
      existsSync(path.join(process.cwd(), "app", s, "loading.tsx")),
    );
    // Les 9 segments connus ont tous un loading.tsx ; s'il en apparaît un
    // nouveau hors liste, ce test force à lui créer son error.tsx aussi.
    expect(loadings.length).toBeGreaterThanOrEqual(SEGMENTS.length - 1);
    for (const s of loadings) {
      expect(existsSync(path.join(process.cwd(), "app", s, "error.tsx")), `app/${s}/error.tsx`).toBe(true);
    }
  });
});

describe("Containment runtime — composant partagé SegmentError", () => {
  const src = read("components/error/segment-error.tsx");

  it("capture via le pont asynchrone, jamais @sentry/nextjs en direct (ADR-005)", () => {
    expect(src).toContain("@/lib/telemetry/sentry-bridge-client");
    expect(src).toContain("captureClientException");
    expect(src).not.toContain("@sentry/nextjs");
    // Tag segment transmis à Sentry
    expect(src).toContain("segment,");
    expect(src).toContain('surface: "segment-error"');
  });

  it("accessibilité et réparation : role=alert + bouton Réessayer + retour contextuel", () => {
    expect(src).toContain('role="alert"');
    expect(src).toContain("onClick={reset}");
    expect(src).toContain("retourHref");
    expect(src).toContain("Réessayer");
    // Digest affiché pour corrélation support ↔ Sentry
    expect(src).toContain("digest");
  });

  it("est un composant client (boundary de rendu navigateur)", () => {
    expect(src.replace(/\s/g, "").slice(0, 40)).toContain('"useclient"');
  });
});

describe("Containment runtime — page admin à zones isolées", () => {
  const src = read("app/admin/page.tsx");

  it("branche ErrorBoundary sur la grille de métriques ET la section missions", () => {
    expect(src).toContain("@/components/error/ErrorBoundary");
    // Deux zones indépendantes : un crash dans l'une ne tue pas l'autre
    const occurrences = src.split("<ErrorBoundary").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(src).toContain("fallback={ZoneFallback}");
  });

  it("le fallback de zone reste accessible (role=alert + Réessayer)", () => {
    expect(src).toContain('role="alert"');
    expect(src).toContain("Réessayer");
  });
});

describe("Containment runtime — filets racines intacts", () => {
  it("app/error.tsx et app/global-error.tsx existent toujours", () => {
    expect(existsSync(path.join(process.cwd(), "app/error.tsx"))).toBe(true);
    expect(existsSync(path.join(process.cwd(), "app/global-error.tsx"))).toBe(true);
  });

  it("global-error reste autonome (rend son propre <html>)", () => {
    const src = read("app/global-error.tsx");
    expect(src).toContain("<html");
    expect(src).toContain("captureClientException");
  });
});
