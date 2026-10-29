import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKUP_POLICY,
  COLLECTIONS_CRITIQUES,
  ageExportHeures,
  conformiteBackup,
  exportEstFrais,
  perimetreRestauration,
} from "@/lib/db/backup-policy";

/**
 * Garde-fou — STRATÉGIE DE SAUVEGARDE FIRESTORE (itération 23, Job 478451).
 *
 * Constat : le projet ne sauvegardait que les RÈGLES Firestore — aucune
 * stratégie pour les DONNÉES (users, tasks, agents, memories, conversations…).
 * Une perte de données aurait été irréversible. Ce test verrouille :
 * 1. la politique codifiée (RPO 24 h, RTO 2 h, rétention 30 j, PITR 7 j) ;
 * 2. les calculs de fraîcheur fail-closed (âge inconnu = jamais frais) ;
 * 3. le périmètre des collections critiques (aucune restauration partielle) ;
 * 4. les opérateurs CLI (modes sûrs, lecture seule par défaut, aucun secret
 *    en dur) ;
 * 5. le runbook complet (couvre toutes les collections critiques).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/* ------------------------- Politique codifiée ------------------------- */

describe("Politique de sauvegarde — valeurs verrouillées", () => {
  it("RPO 24 h, RTO 2 h, rétention 30 j, PITR 7 j, fraîcheur max 25 h", () => {
    expect(BACKUP_POLICY.rpoHeures).toBe(24);
    expect(BACKUP_POLICY.rtoHeures).toBe(2);
    expect(BACKUP_POLICY.retentionJours).toBe(30);
    expect(BACKUP_POLICY.pitrJours).toBe(7);
    expect(BACKUP_POLICY.fraicheurMaxHeures).toBe(25);
  });

  it("la fraîcheur maximale couvre le RPO avec marge d'exécution", () => {
    expect(BACKUP_POLICY.fraicheurMaxHeures).toBeGreaterThanOrEqual(BACKUP_POLICY.rpoHeures);
    expect(BACKUP_POLICY.fraicheurMaxHeures).toBeLessThan(BACKUP_POLICY.rpoHeures + 12);
  });

  it("dix collections critiques, dont users/conversations/memories", () => {
    expect(COLLECTIONS_CRITIQUES.length).toBeGreaterThanOrEqual(10);
    for (const c of ["users", "conversations", "memories", "tasks", "agents"]) {
      expect(COLLECTIONS_CRITIQUES).toContain(c as (typeof COLLECTIONS_CRITIQUES)[number]);
    }
  });
});

/* --------------------------- Calculs fraîcheur ------------------------- */

describe("Calculs de fraîcheur — fail-closed", () => {
  const maintenant = new Date("2026-10-29T05:00:00Z");
  const il_y_a_5h = { done: true, metadata: { startTime: "2026-10-29T00:00:00Z" } };
  const il_y_a_40h = { done: true, metadata: { startTime: "2026-10-27T13:00:00Z" } };
  const en_cours = { done: false, metadata: { startTime: "2026-10-29T04:59:00Z" } };

  it("âge calculé depuis metadata.startTime", () => {
    expect(ageExportHeures(il_y_a_5h, maintenant)).toBeCloseTo(5, 5);
  });

  it("âge inconnu = Infinity (jamais considéré frais)", () => {
    expect(ageExportHeures({ done: true }, maintenant)).toBe(Number.POSITIVE_INFINITY);
    expect(ageExportHeures({ done: true, metadata: { startTime: "bogus" } }, maintenant)).toBe(Number.POSITIVE_INFINITY);
    expect(ageExportHeures(null as never, maintenant)).toBe(Number.POSITIVE_INFINITY);
  });

  it("export en cours = jamais frais tant que done !== true", () => {
    expect(exportEstFrais(en_cours, maintenant)).toBe(false);
    expect(exportEstFrais(il_y_a_5h, maintenant)).toBe(true);
    expect(exportEstFrais(il_y_a_40h, maintenant)).toBe(false);
  });

  it("conformité : aucun export = non conforme avec raison explicite", () => {
    const c = conformiteBackup([], maintenant);
    expect(c.conforme).toBe(false);
    expect(c.raison).toContain("aucun export");
  });

  it("conformité : export frais = conforme ; export périmé = non conforme avec âge", () => {
    const ok = conformiteBackup([il_y_a_5h], maintenant);
    expect(ok.conforme).toBe(true);
    expect(ok.ageHeures).toBeCloseTo(5, 5);

    const ko = conformiteBackup([il_y_a_40h], maintenant);
    expect(ko.conforme).toBe(false);
    expect(ko.raison).toContain("40");
    expect(ko.raison).toContain("RPO");
  });

  it("conformité : le plus récent des exports terminés fait foi", () => {
    const c = conformiteBackup([il_y_a_40h, il_y_a_5h], maintenant);
    expect(c.conforme).toBe(true);
    expect(c.exportLePlusRecent).toBe(il_y_a_5h);
  });
});

/* ----------------------------- Opérateurs CLI -------------------------- */

describe("Opérateurs CLI — sûreté structurelle", () => {
  const backup = read("scripts/backup_firestore_data.mjs");
  const verify = read("scripts/verify_backup_restore.mjs");

  it("modes documentés : --status / --export / --enable-pitr", () => {
    expect(backup).toContain('"--status"');
    expect(backup).toContain('"--export"');
    expect(backup).toContain('"--enable-pitr"');
  });

  it("aucun mode destructif : pas d'appel documents:import / delete", () => {
    // La restauration est volontairement hors script (runbook, double contrôle).
    expect(backup).not.toContain("documents:import");
    expect(backup).not.toContain("documents:delete");
    expect(backup).not.toContain("deleteDoc");
  });

  it("destination d'export exige GCS_BACKUP_BUCKET (jamais de chemin local implicite)", () => {
    expect(backup).toContain("GCS_BACKUP_BUCKET");
    expect(backup).toContain("process.exit(2)"); // refus net sans bucket
  });

  it("clé de service absente = échec fail-closed (exit non nul)", () => {
    expect(verify).toContain("process.exit(1)");
    expect(verify).toContain("fail-closed");
  });

  it("aucun identifiant en dur (les secrets restent dans .fb_deploy_key.json)", () => {
    expect(backup).not.toMatch(/private_key:\s*["'`]/);
    expect(verify).not.toMatch(/private_key:\s*["'`]/);
  });

  it("la vérification teste 4 contrôles dont PITR, schedule, fraîcheur, runbook", () => {
    expect(verify).toContain("PITR");
    expect(verify).toContain("backupSchedules");
    expect(verify).toContain("conformiteBackup");
    expect(verify).toContain("runbook");
  });

  it("les scripts importent la politique du module partagé (source unique)", () => {
    expect(backup).toContain("backup-policy");
    expect(verify).toContain("backup-policy");
  });
});

/* -------------------------------- Runbook ------------------------------ */

describe("Runbook sauvegarde-restauration — complétude", () => {
  const runbook = read("docs/runbooks/sauvegarde-restauration.md");

  it("existe et documente RPO/RTO, PITR, export GCS, exercice trimestriel", () => {
    expect(existsSync(path.join(process.cwd(), "docs/runbooks/sauvegarde-restauration.md"))).toBe(true);
    expect(runbook).toContain("RPO");
    expect(runbook).toContain("RTO");
    expect(runbook).toContain("PITR");
    expect(runbook).toContain("firestore-exports");
    expect(runbook).toContain("Trimestrielle");
  });

  it("couvre TOUTES les collections critiques (garde-fou anti-restauration partielle)", () => {
    for (const c of perimetreRestauration()) {
      expect(runbook).toContain(c);
    }
  });

  it("interdit l'import direct en prod (base d'écart obligatoire)", () => {
    expect(runbook).toContain("gen3ia-import");
    expect(runbook).toContain("JAMAIS directement en prod");
  });
});
