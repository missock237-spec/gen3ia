import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPACITES_PAR_NIVEAU,
  definirEntrepotCles,
  delivrerCleEntrainement,
  exigerCleEntrainement,
  hacherCleEntrainement,
  listerClesEntrainement,
  niveauAutorisePourPlan,
  PREFIXE_CLE_ENTRAINEMENT,
  revoquerCleEntrainement,
  verifierCleEntrainement,
  creerEntrepotClesFichiers,
} from "./cles-entrainement";

/**
 * CLÉS DE NIVEAU UNIQUE D'ENTRAÎNEMENT — la garde PRÉ-ENTRAÎNEMENT exigée
 * par la facturation. Entrepôt FICHIERS réel dans un tmpdir (aucun mock de
 * logique : délivrance, hash, vérification, révocation sont exercés pour de vrai).
 */
describe("cles-entrainement — garde facturation avant entraînement", () => {
  beforeEach(() => {
    definirEntrepotCles(creerEntrepotClesFichiers(mkdtempSync(join(tmpdir(), "g3t-test-"))));
  });

  it("mapping plan → niveau maximal délivrable (grille commerciale)", () => {
    expect(niveauAutorisePourPlan("gratuit")).toBeNull();
    expect(niveauAutorisePourPlan("pro")).toBe("standard");
    expect(niveauAutorisePourPlan("entreprise")).toBe("avance");
    expect(niveauAutorisePourPlan("modele-sur-mesure")).toBe("integral");
  });

  it("délivrance : plan couvrant → clé g3t_ unique, stockée par SHA-256 seulement", async () => {
    const resultat = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    expect(resultat.cle.startsWith(PREFIXE_CLE_ENTRAINEMENT)).toBe(true);
    expect(resultat.cle).toContain("standard_");
    expect(hacherCleEntrainement(resultat.cle)).toBe(resultat.keyId);
    const cles = await listerClesEntrainement("utilisateur-1");
    expect(cles).toHaveLength(1);
    expect(cles[0].source).toBe("facturation");
    expect(JSON.stringify(cles[0])).not.toContain(resultat.cle); // jamais de secret au repos
  });

  it("délivrance refusée : plan gratuit ou niveau supérieur au plan", async () => {
    await expect(
      delivrerCleEntrainement({ userId: "u", niveau: "standard", planId: "gratuit", planActif: true }),
    ).rejects.toThrow(/ne couvre pas le niveau.*aucun/s);
    await expect(
      delivrerCleEntrainement({ userId: "u", niveau: "integral", planId: "pro", planActif: true }),
    ).rejects.toThrow(/ne couvre pas le niveau/);
  });

  it("vérification : clé valable au niveau requis → autorisé avec capacités", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "avance",
      planId: "entreprise",
      planActif: true,
    });
    const verdict = await verifierCleEntrainement({ userId: "utilisateur-1", cle, niveauRequis: "standard" });
    expect(verdict.autorise).toBe(true);
    if (verdict.autorise) {
      expect(verdict.niveau).toBe("avance");
      expect(CAPACITES_PAR_NIVEAU[verdict.niveau].parametresMax).toBeGreaterThan(0);
    }
  });

  it("vérification : refus HONNÊTE et actionnable dans chaque cas de blocage", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    // clé d'un AUTRE compte
    const autre = await verifierCleEntrainement({ userId: "utilisateur-2", cle, niveauRequis: "standard" });
    expect(autre.autorise).toBe(false);
    if (!autre.autorise) expect(autre.raison).toMatch(/inconnue pour ce compte/);
    // niveau insuffisant
    const insuffisant = await verifierCleEntrainement({ userId: "utilisateur-1", cle, niveauRequis: "integral" });
    expect(insuffisant.autorise).toBe(false);
    if (!insuffisant.autorise) {
      expect(insuffisant.raison).toMatch(/insuffisante pour « integral »/);
      expect(insuffisant.remediation).toMatch(/\/api\/training\/keys/);
    }
    // format invalide
    const invalide = await verifierCleEntrainement({ userId: "utilisateur-1", cle: "zzz-invalide", niveauRequis: "standard" });
    expect(invalide.autorise).toBe(false);
    // clé révoquée
    await revoquerCleEntrainement({ userId: "utilisateur-1", cle });
    const revoquee = await verifierCleEntrainement({ userId: "utilisateur-1", cle, niveauRequis: "standard" });
    expect(revoquee.autorise).toBe(false);
    if (!revoquee.autorise) expect(revoquee.raison).toMatch(/révoquée/);
  });

  it("exigerCleEntrainement : jette avec démarche d'obtention (jamais de dérogation)", async () => {
    await expect(
      exigerCleEntrainement({ userId: "utilisateur-1", cle: "g3t_standard_absente", niveauRequis: "standard" }),
    ).rejects.toThrow(/refusé.*facturation/s);
  });

  it("révocation ciblée : la clé du compte est révoquée, une autre non", async () => {
    const { cle: cleA } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const { cle: cleB } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    expect(await revoquerCleEntrainement({ userId: "utilisateur-1", cle: cleA })).toBe(true);
    const verdictB = await verifierCleEntrainement({ userId: "utilisateur-1", cle: cleB, niveauRequis: "standard" });
    expect(verdictB.autorise).toBe(true);
    expect(await revoquerCleEntrainement({ userId: "utilisateur-2", cle: cleB })).toBe(false);
  });
});
