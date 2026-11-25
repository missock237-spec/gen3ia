import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { sanitiserTexte, sanitiserObjet, refuserSiSecret } from "../security/secrets-protection";
import { LIMITES_SANDBOX_UCE } from "../security/sandbox-manager";
import { autoriserExecutionUce } from "../security/permission-manager";
import { enregistrerUsageRessource, LIMITES_RESSOURCES } from "../monitoring/resource-monitor";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";

/**
 * TESTS SECURITY (mission §11) — secrets fail-closed, sandbox bornée,
 * permissions en couches, limites de ressources mesurées.
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-sec-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("protection des secrets", () => {
  it("détecte un token en clair (fail-closed)", () => {
    const decision = refuserSiSecret("voici mon token hf_FAKEAAAABBBBCCCCDDDDEEEEFFFFGGGG dans le texte");
    expect(decision.autorise).toBe(false);
  });

  it("masque un pattern de secret dans un texte autorisé", () => {
    const res = sanitiserTexte("valeur: sk-proj-abc123def456ghi789");
    expect(res.texte).not.toContain("sk-proj-abc123def456ghi789");
  });

  it("sanitise les objets en profondeur (chaînes seulement)", () => {
    const res = sanitiserObjet({ ok: true, champ: "token: KGAT_FAKEAAAABBBBCCCCDDDDEEEE", nombre: 42 });
    expect(res.ok).toBe(true);
    const valeur = res.valeur as { champ: string };
    expect(valeur.champ).not.toContain("KGAT_FAKEAAAABBBBCCCCDDDDEEEE");
  });
});

describe("sandbox et ressources", () => {
  it("les limites sandbox sont réelles et bornées", () => {
    expect(LIMITES_SANDBOX_UCE.timeoutMs).toBeGreaterThan(0);
    expect(LIMITES_SANDBOX_UCE.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(LIMITES_SANDBOX_UCE.memoryMb).toBeLessThanOrEqual(512);
  });

  it("enregistre une mesure de ressource et signale un dépassement", async () => {
    const ok = await enregistrerUsageRessource({ capabilityId: "test:res:a", dureeMs: 100, memoirePicMo: 40 }, { dossier, forcerLocal: true });
    expect(ok.ok).toBe(true);
    expect(ok.limiteDepassee).toBe(false);
    const trop = await enregistrerUsageRessource({ capabilityId: "test:res:b", dureeMs: LIMITES_RESSOURCES.dureeMaxMs * 2 }, { dossier, forcerLocal: true });
    expect(trop.limiteDepassee).toBe(true);
  });
});

describe("permissions en couches", () => {
  it("une décision est toujours tracée par couche avec une raison finale", async () => {
    const resultat = await autoriserExecutionUce({ userId: "u-test", executionId: "exec-sec-1", toolName: "outil.definitivement.inconnu.xyz" });
    // l'outil inconnu doit être refusé (politique d'allowlist) — l'arrêt
    // d'urgence dépend du backend réel (peut lever hors serveur) : dans tous
    // les cas au moins une couche est tracée + une raison finale honnête.
    expect(resultat.autorise).toBe(false);
    expect(resultat.decisions.length).toBeGreaterThanOrEqual(1);
    expect(resultat.decisions[0].couche).toBe("arret-urgence");
    expect(resultat.raisonFinale.length).toBeGreaterThan(0);
  });
});
