import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  effacerEtatCompteurs,
  FICHIER_COMPTEURS_DEFAUT,
  fichierCompteurs,
  lireEtatCompteurs,
  lireModePersistanceCompteurs,
  persisterBlocCompteur,
  VAR_ENV_FICHIER_COMPTEURS,
} from "@/lib/neural/persistance-compteurs";
import {
  enregistrerReponsePont,
  lireCompteurPontVocation,
  reinitialiserCompteurPontVocation,
} from "@/lib/neural/compteur-pont-vocation";

/**
 * GARDE 46ᵉ — PERSISTANCE DES COMPTEURS DE SOBRIÉTÉ (it.78) : la limite
 * historique it.74/it.75 (« compteurs remis à zéro à chaque redéploiement »)
 * est levée SANS rien inventer — les sommes d'entiers mesurées sont
 * recopiées telles quelles sur disque (var/neural/compteurs-energie.json,
 * écriture atomique) et leur repli mémoire est DÉCLARÉ publiquement.
 *
 * Hermeticité : chaque worker redirige le fichier via
 * GEN3_COMPTEURS_FICHIER vers un chemin temporaire unique — aucun test
 * n'écrit jamais dans le chemin de production, et le chemin par défaut est
 * vérifié structurellement (constante + gitignore var/).
 */

const DIR_TMP = join(tmpdir(), `gen3-compteurs-it78-${process.pid}-${Math.random().toString(36).slice(2)}`);
const FICHIER_TMP = join(DIR_TMP, "compteurs-energie.json");
const ORIGINE = "2026-11-01T00:00:00.000Z";

beforeAll(() => {
  mkdirSync(DIR_TMP, { recursive: true });
  process.env[VAR_ENV_FICHIER_COMPTEURS] = FICHIER_TMP;
});

afterAll(() => {
  rmSync(DIR_TMP, { recursive: true, force: true });
  delete process.env[VAR_ENV_FICHIER_COMPTEURS];
});

beforeEach(() => {
  effacerEtatCompteurs();
});

describe("GARDE 46ᵉ — le fichier de persistance est honnête (lecture/écriture réelles)", () => {
  it("1. écriture atomique + relecture exacte du bloc (sommes recopiées, jamais transformées)", () => {
    const ok = persisterBlocCompteur("pont", { reponsesServies: 12, refusHonnêtes: 3 }, ORIGINE);
    expect(ok).toBe(true);
    expect(existsSync(FICHIER_TMP)).toBe(true);
    // Aucun fichier temporaire résiduel (écriture atomique tmp + rename).
    expect(existsSync(`${FICHIER_TMP}.tmp`)).toBe(false);
    const etat = lireEtatCompteurs();
    expect(etat).not.toBeNull();
    expect(etat?.origineIso).toBe(ORIGINE);
    expect(etat?.pont?.reponsesServies).toBe(12);
    expect(etat?.pont?.refusHonnêtes).toBe(3);
    expect(etat?.moteur).toBeUndefined();
  });

  it("2. la fusion préserve l'autre bloc (pont et moteur coexistent sans écrasement)", () => {
    persisterBlocCompteur("pont", { reponsesServies: 5, refusHonnêtes: 1 }, ORIGINE);
    persisterBlocCompteur(
      "moteur",
      { fenetresExecutees: 2, fenetresEvitees: 9, epoquesRPIAEvitees: 108, cyclesNoyauEvites: 36 },
      ORIGINE,
    );
    const etat = lireEtatCompteurs();
    expect(etat?.pont?.reponsesServies).toBe(5);
    expect(etat?.moteur?.fenetresEvitees).toBe(9);
    expect(etat?.moteur?.epoquesRPIAEvitees).toBe(108);
    expect(etat?.origineIso).toBe(ORIGINE);
  });

  it("3. fichier corrompu ou mal formé → lecture null (zéro honnête, jamais d'exception)", () => {
    writeFileSync(FICHIER_TMP, "{ ceci n'est pas du JSON", "utf8");
    expect(lireEtatCompteurs()).toBeNull();
    writeFileSync(FICHIER_TMP, JSON.stringify({ version: 2, origineIso: "pas-une-date" }), "utf8");
    expect(lireEtatCompteurs()).toBeNull();
    writeFileSync(
      FICHIER_TMP,
      JSON.stringify({ version: 2, origineIso: ORIGINE, pont: { reponsesServies: -4, refusHonnêtes: 0 } }),
      "utf8",
    );
    // Un compteur négatif n'est pas une somme d'entiers mesurée → rejeté.
    expect(lireEtatCompteurs()?.pont).toBeUndefined();
  });

  it("4. le mode de persistance est constaté, jamais supposé (fichier ↔ memoire)", () => {
    expect(lireModePersistanceCompteurs()).toBeNull(); // rien écrit, rien constaté
    expect(persisterBlocCompteur("pont", { reponsesServies: 1, refusHonnêtes: 0 }, ORIGINE)).toBe(true);
    expect(lireModePersistanceCompteurs()).toBe("fichier");
    // Écriture impossible : le parent du chemin est un FICHIER régulier.
    const fichierBloquant = join(DIR_TMP, "pas-un-dossier");
    writeFileSync(fichierBloquant, "x", "utf8");
    const precedent = process.env[VAR_ENV_FICHIER_COMPTEURS];
    try {
      process.env[VAR_ENV_FICHIER_COMPTEURS] = join(fichierBloquant, "sous-dossier", "compteurs.json");
      const ok = persisterBlocCompteur("pont", { reponsesServies: 2, refusHonnêtes: 0 }, ORIGINE);
      expect(ok).toBe(false);
      expect(lireModePersistanceCompteurs()).toBe("memoire");
    } finally {
      process.env[VAR_ENV_FICHIER_COMPTEURS] = precedent;
    }
  });

  it("5. l'effacement est complet (garde/tests) : fichier absent, mode neutre", () => {
    persisterBlocCompteur("pont", { reponsesServies: 1, refusHonnêtes: 0 }, ORIGINE);
    effacerEtatCompteurs();
    expect(existsSync(FICHIER_TMP)).toBe(false);
    expect(lireEtatCompteurs()).toBeNull();
    expect(lireModePersistanceCompteurs()).toBeNull();
  });

  it("6. AMORÇAGE réel : le compteur du pont reprend la somme persistée et garde l'origine", () => {
    reinitialiserCompteurPontVocation(); // état vide honnête (fichier effacé)
    // La somme « de la vie antérieure au redéploiement » est écrite sur disque…
    persisterBlocCompteur("pont", { reponsesServies: 5, refusHonnêtes: 2 }, ORIGINE);
    // … un nouveau conteneur (redéploiement simulé) s'amorce DEPUIS le disque :
    enregistrerReponsePont();
    const c = lireCompteurPontVocation();
    expect(c.reponsesServies).toBe(6); // 5 persistés + 1 mesurée maintenant
    expect(c.refusHonnêtes).toBe(2);
    expect(c.demarrageIso).toBe(ORIGINE); // l'origine de la mesure survit
    // et l'incrément est immédiatement re-persisté :
    expect(lireEtatCompteurs()?.pont?.reponsesServies).toBe(6);
  });
});

describe("GARDE 46ᵉ — le chemin de production est déclaré et hors git", () => {
  it("7. le chemin par défaut est var/neural/compteurs-energie.json (convention var/ gitignorée)", () => {
    expect(FICHIER_COMPTEURS_DEFAUT).toContain(join("var", "neural", "compteurs-energie.json"));
    expect(fichierCompteurs()).toBe(FICHIER_TMP); // redirection active dans ce worker
    delete process.env[VAR_ENV_FICHIER_COMPTEURS];
    expect(fichierCompteurs()).toBe(FICHIER_COMPTEURS_DEFAUT); // sans env → chemin par défaut
    process.env[VAR_ENV_FICHIER_COMPTEURS] = FICHIER_TMP;
  });

  it("8. var/ est gitignore (l'état local du processus n'est jamais committé)", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    expect(gitignore).toMatch(/^var\/$/m);
  });
});
