import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Task 108-b — gardes de source (pattern « garde fs » du dépôt, cf.
 * lib/queue/origin.test.ts).
 *
 * Contrats structurels verrouillés :
 * 1. la base d'identités = R2 UNIQUEMENT : lib/identity n'importe JAMAIS
 *    firebase-admin / lib/firebase (Firestore reste le moteur des données
 *    domaines, mais l'identité ne dépend d'aucun autre stockage) ;
 * 2. lib/identity n'accède à R2 que par le client existant @/lib/storage/r2
 *    (aucun import direct du SDK @aws-sdk/*) ;
 * 3. les routes auth n'importent PLUS ensureUserProfile (la base users/{uid}
 *    Firestore n'est plus le mécanisme de profil des routes de session) ;
 * 4. la cascade RGPD du compte passe par deleteIdentityForAccount.
 */

function listerTs(dossierRelatif: string): string[] {
  const absolu = path.join(process.cwd(), dossierRelatif);
  return readdirSync(absolu, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(dossierRelatif, f));
}

const lire = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("garde : lib/identity — base R2 uniquement (aucun firebase-admin)", () => {
  const fichiers = listerTs("lib/identity");

  it("les modules d'identité n'importent ni firebase-admin ni lib/firebase", () => {
    expect(fichiers).toEqual(expect.arrayContaining(["lib/identity/schema.ts", "lib/identity/r2-identity-store.ts", "lib/identity/service.ts"]));
    for (const file of fichiers) {
      const source = lire(file);
      expect(source, `${file} ne doit pas dépendre de firebase-admin`).not.toMatch(/from\s+"firebase-admin/);
      expect(source, `${file} ne doit pas dépendre de lib/firebase`).not.toMatch(/@\/lib\/firebase/);
      expect(source, `${file} ne doit pas dépendre de Supabase`).not.toMatch(/@\/lib\/supabase|@supabase\//);
    }
  });

  it("l'accès R2 passe UNIQUEMENT par le client existant @/lib/storage/r2", () => {
    for (const file of fichiers) {
      const source = lire(file);
      expect(source, `${file} ne doit pas importer le SDK AWS directement`).not.toMatch(/@aws-sdk\//);
      if (source.includes("putObject(") || source.includes("downloadFromR2(") || source.includes("deleteFromR2(")) {
        expect(source, `${file} doit importer le client @/lib/storage/r2`).toContain('@/lib/storage/r2');
      }
    }
  });
});

describe("garde : routes auth — plus aucun ensureUserProfile (Firestore users/{uid})", () => {
  const routes = ["app/api/auth/session/route.ts", "app/api/auth/profile/route.ts"];

  it("aucune route session/profile n'importe lib/firebase/users (grep source)", () => {
    for (const file of routes) {
      const source = lire(file);
      expect(source, `${file} ne doit plus importer ensureUserProfile`).not.toContain("ensureUserProfile");
      expect(source, `${file} ne doit plus référencer lib/firebase/users`).not.toContain("@/lib/firebase/users");
    }
  });

  it("les routes session/profile provisionnent via la base d'identités R2", () => {
    expect(lire("app/api/auth/session/route.ts")).toContain("ensureIdentity");
    expect(lire("app/api/auth/profile/route.ts")).toContain("updateIdentity");
  });

  it("la cascade RGPD du compte passe par deleteIdentityForAccount (base R2)", () => {
    const source = lire("app/api/auth/account/route.ts");
    expect(source).toContain("deleteIdentityForAccount");
    // Panne R2 ne bloque pas la suppression : le try/catch « journalise et
    // continue » est structurellement présent.
    expect(source).toMatch(/identity_delete_failed_continued/);
  });
});
