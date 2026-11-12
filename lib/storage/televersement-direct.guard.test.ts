/**
 * GARDE BIDIRECTIONNELLE — Téléversement direct navigateur → R2.
 *
 * Incidence réelle corrigée (production, 2026-11-10) : le bucket R2 restait
 * SANS règle CORS (le bootstrap n'existait que sur la route de diagnostic
 * admin, jamais appelée) — le préflight OPTIONS du navigateur échouait en
 * 403 sans Access-Control-Allow-Origin, le PUT direct était bloqué, et
 * chaque pièce jointe du chat se soldait par « Erreur de génération — le
 * message est conservé dans la zone de saisie ». Trois verrous :
 *   1. la décision de bootstrap (pure) respecte ses bornes exactes ;
 *   2. les origines autorisées n'exposent JAMAIS localhost en production ;
 *   3. le câblage source : session → auto-réparation, fail-soft total,
 *      toast honnête portant la cause réelle.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CORS_BOOTSTRAP_REPRISE_APRES_ECHEC_MS,
  CORS_BOOTSTRAP_TTL_REUSSITE_MS,
  decisionBootstrapCors,
  originesTeleversementDirect,
  reinitialiseCacheCorsPourTest,
} from "./r2";

const RACINE = process.cwd();

function lit(chemin: string): string {
  return readFileSync(`${RACINE}/${chemin}`, "utf8");
}

describe("garde téléversement direct — décision bootstrap CORS (pure)", () => {
  it("bornes exactes : TTL de réussite = 6 h, reprise après échec = 10 min", () => {
    expect(CORS_BOOTSTRAP_TTL_REUSSITE_MS).toBe(6 * 60 * 60 * 1000);
    expect(CORS_BOOTSTRAP_REPRISE_APRES_ECHEC_MS).toBe(10 * 60 * 1000);
  });

  it("tente le bootstrap quand rien n'a encore été fait (0, 0)", () => {
    expect(decisionBootstrapCors(0, 0, 1_000_000)).toBe(true);
  });

  it("ne retente PAS dans les 6 h suivant un succès", () => {
    const succes = 1_000_000;
    const justeAvant = succes + CORS_BOOTSTRAP_TTL_REUSSITE_MS - 1;
    expect(decisionBootstrapCors(succes, 0, justeAvant)).toBe(false);
    expect(decisionBootstrapCors(succes, 0, succes + 60_000)).toBe(false);
  });

  it("retente après expiration du TTL de réussite (6 h + 1 ms)", () => {
    const succes = 1_000_000;
    const apres = succes + CORS_BOOTSTRAP_TTL_REUSSITE_MS + 1;
    expect(decisionBootstrapCors(succes, 0, apres)).toBe(true);
  });

  it("un échec RÉCENT bloque la reprise même sans succès antérieur", () => {
    const echec = 5_000_000;
    expect(decisionBootstrapCors(0, echec, echec + 60_000)).toBe(false);
    expect(decisionBootstrapCors(0, echec, echec + CORS_BOOTSTRAP_REPRISE_APRES_ECHEC_MS - 1)).toBe(false);
  });

  it("la reprise redevient possible après la fenêtre d'échec (10 min + 1 ms)", () => {
    const echec = 5_000_000;
    expect(decisionBootstrapCors(0, echec, echec + CORS_BOOTSTRAP_REPRISE_APRES_ECHEC_MS + 1)).toBe(true);
  });

  it("est déterministe (mêmes entrées → même décision)", () => {
    const a = decisionBootstrapCors(42, 0, 999);
    const b = decisionBootstrapCors(42, 0, 999);
    expect(a).toBe(b);
  });
});

describe("garde téléversement direct — origines CORS", () => {
  it("production : origines gén3ia (APP_URL ou défaut) + www, JAMAIS localhost", () => {
    const sauvegardeNodeEnv = process.env.NODE_ENV;
    const sauvegardeAppUrl = process.env.APP_URL;
    try {
      process.env.NODE_ENV = "production";
      process.env.APP_URL = "https://gen3ia.online";
      const origines = originesTeleversementDirect();
      expect(origines).toContain("https://gen3ia.online");
      expect(origines).toContain("https://www.gen3ia.online");
      expect(origines.some((o) => o.includes("localhost"))).toBe(false);
    } finally {
      process.env.NODE_ENV = sauvegardeNodeEnv;
      process.env.APP_URL = sauvegardeAppUrl;
    }
  });

  it("développement : le clone local http://localhost:3000 est accepté", () => {
    const sauvegardeNodeEnv = process.env.NODE_ENV;
    const sauvegardeAppUrl = process.env.APP_URL;
    try {
      process.env.NODE_ENV = "development";
      process.env.APP_URL = "http://localhost:3000";
      const origines = originesTeleversementDirect();
      expect(origines).toContain("http://localhost:3000");
      expect(origines).toContain("https://www.gen3ia.online");
    } finally {
      process.env.NODE_ENV = sauvegardeNodeEnv;
      process.env.APP_URL = sauvegardeAppUrl;
    }
  });
});

describe("garde téléversement direct — câblage source (balayage)", () => {
  it("la règle CORS appliquée expose ETag et accepte PUT/GET/HEAD + tout en-tête", () => {
    const source = lit("lib/storage/r2.ts");
    expect(source).toContain("PutBucketCorsCommand");
    expect(source).toContain('AllowedMethods: ["PUT", "GET", "HEAD"]');
    expect(source).toContain('AllowedHeaders: ["*"]');
    expect(source).toContain('ExposeHeaders: ["ETag"]');
    expect(source).toContain("MaxAgeSeconds: 3600");
  });

  it("l'auto-réparation est fail-soft : try/catch + console.warn + jamais de throw", () => {
    const source = lit("lib/storage/r2.ts");
    const corps = source.slice(source.indexOf("export async function assureBucketCorsPourTeleversement"));
    const finCorps = corps.indexOf("/** Remise à zéro du cache");
    const bloc = corps.slice(0, finCorps);
    expect(bloc).toContain("try");
    expect(bloc).toContain("catch");
    expect(bloc).toContain("console.warn");
    expect(bloc).toContain("return false");
    // La fonction ne lève JAMAIS : aucun throw dans son corps.
    expect(bloc).not.toMatch(/throw /);
  });

  it("l'ouverture de session déclenche l'auto-réparation AVANT toute multipart R2", () => {
    const source = lit("lib/storage/permanent-user-storage.ts");
    const debut = source.indexOf("export async function createUploadSessions");
    const fin = source.indexOf("export async function commitUpload");
    const bloc = source.slice(debut, fin);
    const positionAuto = bloc.indexOf("await assureBucketCorsPourTeleversement()");
    const positionMultipart = bloc.indexOf("createMultipartUpload(");
    expect(positionAuto).toBeGreaterThan(-1);
    expect(positionMultipart).toBeGreaterThan(-1);
    expect(positionAuto).toBeLessThan(positionMultipart);
  });

  it("la route de diagnostic admin conserve son bootstrap CORS (double voie intacte)", () => {
    const source = lit("app/api/storage/r2-diagnostic/route.ts");
    expect(source).toContain("bootstrapBucketCors");
  });

  it("le toast du chat porte la cause RÉELLE (message actionnable) et garde le repli générique", () => {
    const source = lit("components/chat/nova-chat.tsx");
    expect(source).toContain("const raison = err instanceof Error && err.message");
    expect(source).toContain("Erreur de génération — ${raison} Le message est conservé dans la zone de saisie.");
    expect(source).toContain('"Erreur de génération — le message est conservé dans la zone de saisie."');
    // La cause est tronquée (toast lisible) et journalisée pour diagnostic.
    expect(source).toContain("err.message.slice(0, 180)");
    expect(source).toContain('console.error("[nova-chat] envoi impossible :"');
  });

  it("l'import du module r2 relie l'auto-réparation au stockage permanent", () => {
    const source = lit("lib/storage/permanent-user-storage.ts");
    expect(source).toContain("assureBucketCorsPourTeleversement,");
  });
});

describe("garde téléversement direct — bornes de lot 15 × 100 Mo (demande propriétaire)", () => {
  it("la politique porte les nouvelles bornes : 15 fichiers, 100 Mo, socle quota 4 Go", async () => {
    const politique = await import("./upload-policy");
    expect(politique.MAX_FILES_PER_BATCH).toBe(15);
    expect(politique.MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(politique.MAX_USER_QUOTA_BYTES).toBe(4 * 1024 ** 3);
    // La politique unifiée des pièces jointes suit (même socle partagé).
    const pieces = await import("@/lib/files/attachment-policy");
    expect(pieces.ATTACHMENT_MAX_FILES).toBe(15);
    expect(pieces.ATTACHMENT_MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
  });

  it("la route de session dérive sa borne zod de la politique (aucune borne codée en dur)", () => {
    const source = lit("app/api/storage/permanent/session/route.ts");
    expect(source).toContain(".max(MAX_FILES_PER_BATCH)");
    expect(source).not.toMatch(/\.max\(10\)/);
  });

  it("le client de téléversement et le panneau documents dérivent aussi la borne du lot", () => {
    expect(lit("lib/storage/upload-client.ts")).toContain("MAX_FILES_PER_BATCH");
    expect(lit("components/memory/documents-panel.tsx")).toContain("MAX_FILES_PER_BATCH");
    // Aucune copie figée « 10 fichiers » dans les surfaces de téléversement.
    expect(lit("components/memory/documents-panel.tsx")).not.toContain("10 fichiers");
    expect(lit("components/memory/memory-workspace.tsx")).not.toContain("10 fichiers");
    expect(lit("app/memory/page.tsx")).not.toContain("10 fichiers par lot");
  });

  it("le client n'ouvre la session QUE pour les fichiers validés par la politique (pré-validation inchangée)", () => {
    const source = lit("lib/storage/upload-client.ts");
    expect(source).toContain("validateSingleUpload");
    expect(source).toContain('"/api/storage/permanent/session"');
    expect(source).toContain('"/api/storage/permanent/commit"');
  });
});

describe("garde téléversement direct — reset de cache", () => {
  it("reinitialiseCacheCorsPourTest existe et est sans effet de bord", () => {
    expect(typeof reinitialiseCacheCorsPourTest).toBe("function");
    expect(() => reinitialiseCacheCorsPourTest()).not.toThrow();
  });
});
