/**
 * TESTS DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Les cinq conditions de validation du plan sont couvertes :
 *  1. le système démarre automatiquement (armement idempotent, AUTO_CORE) ;
 *  2. les modules peuvent communiquer (bus d'événements inter-modules) ;
 *  3. une panne d'un module ne bloque pas les autres (isolation par tick) ;
 *  4. les opérations interrompues peuvent reprendre (persistance + REPRISE) ;
 *  5. les tâches restent traçables (id unique, historique, idempotence).
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chargerConfigCoeurAutonome } from "./config/autonomous-config";
import { chargerEtat, persisterEtat } from "./lifecycle-manager";
import { Gen3iaCoeurAutonome } from "./orchestrator";
import { PlanificateurCycles } from "./scheduler";
import { GestionnaireTaches } from "./task-manager";
import { executerTickModule } from "./process-manager";
import { agentSanteCerveau } from "../modules/agent-sante-cerveau";
import type { ContexteTick, ModuleAgent, RapportModule } from "./types";

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Module de test : rapport immédiat. */
function moduleSimple(
  id: string,
  rapport: RapportModule | ((cycle: number) => RapportModule),
): ModuleAgent {
  return {
    id,
    nom: `module ${id}`,
    role: "test",
    async tick(ctx) {
      const t = ctx.taches.creer({ module: id, cycle: ctx.cycle, type: "test" });
      if (t) {
        ctx.taches.demarrer(t.id);
        ctx.taches.terminer(t.id);
      }
      return typeof rapport === "function" ? rapport(ctx.cycle) : rapport;
    },
  };
}

describe("ConfigCoeurAutonome", () => {
  it("défauts bornés : cycle 5 min, AUTO_CORE armé", () => {
    const c = chargerConfigCoeurAutonome({});
    expect(c.arme).toBe(true);
    expect(c.intervalleCycleMs).toBe(300_000);
    expect(c.timeoutTickMs).toBe(60_000);
    expect(c.maxTicksConcurrents).toBe(2);
  });

  it("AUTO_CORE=0 désarme ; bornes respectées", () => {
    expect(chargerConfigCoeurAutonome({ AUTO_CORE: "0" }).arme).toBe(false);
    const c = chargerConfigCoeurAutonome({ AUTO_CORE_CYCLE_MS: "1" });
    expect(c.intervalleCycleMs).toBe(60_000); // jamais sous 1 min
  });
});

describe("Scheduler (cycle de base)", () => {
  it("cycle 1 immédiat au démarrage, arrêt propre, idempotence", () => {
    const cycles: number[] = [];
    const p = new PlanificateurCycles(60_000, (c) => cycles.push(c));
    expect(p.demarrer()).toBe(true);
    expect(p.actif()).toBe(true);
    expect(p.cycleCourant()).toBe(1);
    expect(p.demarrer()).toBe(false); // idempotent
    expect(p.arreter()).toBe(true);
    expect(p.actif()).toBe(false);
    expect(cycles).toEqual([1]);
  });
});

describe("GestionnaireTaches (traçabilité)", () => {
  it("id unique, historique complet, idempotence des transitions", () => {
    const g = new GestionnaireTaches();
    const t = g.creer({ module: "test", cycle: 1, type: "essai" });
    expect(t).not.toBeNull();
    expect(t!.id).toMatch(/^T-1-[0-9a-f]{8}$/);
    expect(g.creer({ module: "test", cycle: 1, type: "essai", idExistant: t!.id })).toBeNull();

    expect(g.demarrer(t!.id)).toBe(true);
    expect(g.demarrer(t!.id)).toBe(false); // déjà EN_COURS
    expect(g.terminer(t!.id)).toBe(true);
    expect(g.terminer(t!.id)).toBe(false); // déjà close
    expect(g.echouer(t!.id)).toBe(false); // une tâche close ne se referme pas

    const lu = g.obtenir(t!.id)!;
    expect(lu.statut).toBe("TERMINEE");
    const evenements = lu.historique.map((e) => e.evenement);
    expect(evenements).toEqual(["CREEE", "EN_COURS", "TERMINEE"]);
    expect(g.compteParStatut().TERMINEE).toBe(1);
  });

  it("REPRISE : une tâche EN_COURS persistée repart EN_ATTENTE avec trace", () => {
    const g = new GestionnaireTaches();
    const t = g.creer({ module: "acquisition", cycle: 7, type: "collecte", idExistant: "T-7-fixe" });
    g.demarrer(t!.id);
    const restaurées = g.restaurerOuvertes([JSON.parse(JSON.stringify(t))]);
    expect(restaurées).toBe(0); // déjà connue — pas de doublon
    const g2 = new GestionnaireTaches();
    g2.restaurerOuvertes([JSON.parse(JSON.stringify(t))]);
    const reprise = g2.obtenir("T-7-fixe")!;
    expect(reprise.statut).toBe("EN_ATTENTE");
    expect(reprise.historique.some((e) => e.evenement === "REPRISE")).toBe(true);
  });
});

describe("Lifecycle (persistance + reprise)", () => {
  let dossier: string;
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "coeur-autonome-"));
  });
  afterEach(() => {
    rmSync(dossier, { recursive: true, force: true });
  });

  it("persistance atomique puis relecture fidèle", () => {
    const chemin = persisterEtat(dossier, {
      version: 1,
      demarreLe: "2026-11-25T00:00:00.000Z",
      cycle: 12,
      persisteLe: "2026-11-25T00:05:00.000Z",
      modules: {},
      tachesOuvertes: [],
    });
    expect(chemin).toBe(join(dossier, "etat.json"));
    const lu = chargerEtat(dossier);
    expect(lu?.cycle).toBe(12);
  });

  it("état corrompu ou version inconnue → null (jamais de crash au boot)", () => {
    writeFileSync(join(dossier, "etat.json"), "{pas du json", "utf8");
    expect(chargerEtat(dossier)).toBeNull();
    persisterEtat(dossier, {
      version: 99,
      demarreLe: "x",
      cycle: 1,
      persisteLe: "x",
      modules: {},
      tachesOuvertes: [],
    });
    expect(chargerEtat(dossier)).toBeNull();
    expect(chargerEtat(join(dossier, "absent"))).toBeNull();
  });
});

describe("Process-manager (isolation d'un tick)", () => {
  function ctxMinimal() {
    const taches = new GestionnaireTaches();
    return {
      ctx: {
        cycle: 1,
        dateIso: new Date().toISOString(),
        taches,
        evenementsRecus: [],
        emettreEvenement() {},
      },
      taches,
    };
  }
  const etat = () => ({
    id: "m",
    nom: "m",
    role: "r",
    statut: "actif" as const,
    ticks: 0,
    succes: 0,
    echecs: 0,
    echecsConsecutifs: 0,
    dernieresErreurs: [],
  });

  it("module qui lève → rapport echec honnête, jamais de lever vers le core", async () => {
    const { ctx } = ctxMinimal();
    const agent: ModuleAgent = { id: "m", nom: "m", role: "r", async tick() { throw new Error("boom"); } };
    const r = await executerTickModule(agent, ctx, etat(), {
      timeoutMs: 5_000,
      echecsAvantSuspension: 5,
      suspensionMs: 60_000,
      ticksEnCours: new Map(),
    });
    expect(r.statut).toBe("echec");
    expect(r.message).toBe("boom");
  });

  it("tick coincé → timeout documenté après le budget", async () => {
    const { ctx } = ctxMinimal();
    const agent: ModuleAgent = {
      id: "m",
      nom: "m",
      role: "r",
      async tick() {
        await attendre(5_000);
        return { statut: "succes", message: "trop tard" };
      },
    };
    const r = await executerTickModule(agent, ctx, etat(), {
      timeoutMs: 30,
      echecsAvantSuspension: 5,
      suspensionMs: 60_000,
      ticksEnCours: new Map(),
    });
    expect(r.statut).toBe("timeout");
    expect(r.message).toContain("timeout");
  });

  it("suspension après N échecs consécutifs, réarmement après la durée", async () => {
    const { ctx } = ctxMinimal();
    const agent: ModuleAgent = { id: "m", nom: "m", role: "r", async tick() { return { statut: "echec", message: "ko" }; } };
    const e = etat();
    const opts = { timeoutMs: 5_000, echecsAvantSuspension: 2, suspensionMs: 80, ticksEnCours: new Map<string, boolean>() };
    await executerTickModule(agent, ctx, e, opts);
    const r1 = await executerTickModule(agent, ctx, e, opts);
    expect(r1.statut).toBe("echec");
    expect(e.statut).toBe("suspendu");
    const r2 = await executerTickModule(agent, ctx, e, opts);
    expect(r2.statut).toBe("suspendu");
    await attendre(90);
    const r3 = await executerTickModule(agent, ctx, e, opts);
    expect(r3.statut).toBe("echec"); // réarmé, retente (et échoue encore — le réel)
    expect(e.echecsConsecutifs).toBe(1); // le compteur repart de zéro au réarmement
    expect(e.statut).toBe("actif"); // pas encore de nouvelle suspension (seuil 2)
  });
});

describe("Orchestrator (les 5 conditions de validation du plan)", () => {
  let dossier: string;
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "coeur-orch-"));
  });
  afterEach(() => {
    rmSync(dossier, { recursive: true, force: true });
  });

  /**
   * Config de TEST : intervalle de cycle 10 ms (objet direct — la garde
   * MIN_CYCLE_MS de 60 s ne s'applique qu'au parsing d'environnement). En
   * production le cycle est de 5 min ; ici les cycles se suivent à ~15 ms
   * pour valider les cycles multiples sans attendre une minute.
   */
  function configTest() {
    return { ...chargerConfigCoeurAutonome({}), intervalleCycleMs: 10 };
  }

  it("condition 1 — démarrage idempotent + cycle 1 immédiat avec tous les modules", async () => {
    const coeur = new Gen3iaCoeurAutonome({
      dossier,
      config: chargerConfigCoeurAutonome({ AUTO_CORE_CYCLE_MS: "60000" }),
    });
    coeur.enregistrerModule(moduleSimple("a", { statut: "succes", message: "ok a" }));
    coeur.enregistrerModule(moduleSimple("b", { statut: "rien_a_faire", message: "rien b" }));
    const demarrage = coeur.demarrer();
    expect(demarrage.dejaDemarre).toBe(false);
    expect(coeur.actif()).toBe(true);
    expect(coeur.demarrer().dejaDemarre).toBe(true); // idempotent
    // Le cycle 1 est parti immédiatement au démarrage (non bloquant) —
    // on laisse les ticks immédiats se terminer puis on lit la santé.
    await attendre(40);
    expect(coeur.cycleCourant()).toBe(1);
    const sante = coeur.etat();
    expect(sante.modulesEnregistres).toBe(2);
    expect(sante.modules.find((m) => m.id === "a")!.succes).toBe(1);
    expect(sante.modules.find((m) => m.id === "b")!.ticks).toBe(1);
    coeur.arreter();
    expect(coeur.actif()).toBe(false);
  });

  it("condition 2 — les modules communiquent (bus d'événements sans blocage)", async () => {
    const coeur = new Gen3iaCoeurAutonome({ dossier, config: configTest() });
    let emis = false;
    const emetteur: ModuleAgent = {
      id: "emetteur",
      nom: "e",
      role: "r",
      async tick(ctx) {
        if (!emis) {
          emis = true;
          ctx.emettreEvenement({ de: "emetteur", sujet: "bonjour" });
        }
        return { statut: "rien_a_faire", message: "émission faite" };
      },
    };
    let recu: string | null = null;
    const recepteur: ModuleAgent = {
      id: "recepteur",
      nom: "r",
      role: "r",
      async tick(ctx) {
        if (ctx.evenementsRecus.length > 0) recu = ctx.evenementsRecus[0].sujet;
        return { statut: "rien_a_faire", message: "écoute" };
      },
    };
    coeur.enregistrerModule(emetteur);
    coeur.enregistrerModule(recepteur);
    await coeur.executerCycle();
    await attendre(10);
    await coeur.executerCycle(); // les événements arrivent au PROCHAIN tick
    await attendre(10);
    expect(recu).toBe("bonjour");
  });

  it("condition 3 — une panne d'un module ne bloque pas les autres", async () => {
    const coeur = new Gen3iaCoeurAutonome({ dossier, config: configTest() });
    coeur.enregistrerModule(moduleSimple("casse", { statut: "echec", message: "panne" }));
    coeur.enregistrerModule(moduleSimple("sain", { statut: "succes", message: "a su" }));
    await coeur.executerCycle();
    await attendre(20);
    const sante = coeur.etat();
    expect(sante.statut).toBe("degrade"); // honnête : un module en échec
    expect(sante.modules.find((m) => m.id === "casse")!.echecs).toBe(1);
    expect(sante.modules.find((m) => m.id === "sain")!.succes).toBe(1);
    expect(sante.taches.TERMINEE).toBe(2); // les deux ticks ont tracé leur tâche
  });

  it("condition 4 — reprise des opérations interrompues après redémarrage", async () => {
    // Premier cœur : une tâche laissée EN_COURS (crash simulé) + un cycle
    // exécuté (pour persister un compteur de cycles > 0), puis arrêt.
    const coeur1 = new Gen3iaCoeurAutonome({ dossier, config: configTest() });
    const t = coeur1.taches.creer({ module: "acquisition", cycle: 1, type: "collecte" });
    coeur1.taches.demarrer(t!.id);
    coeur1.enregistrerModule(moduleSimple("acquisition", { statut: "rien_a_faire", message: "ok" }));
    await coeur1.executerCycle();
    await attendre(15);
    coeur1.arreter(); // persiste l'état avec la tâche EN_COURS
    expect(coeur1.cycleCourant()).toBeGreaterThanOrEqual(1);

    // Second cœur (redémarrage du process) : la tâche est marquée REPRISE.
    const coeur2 = new Gen3iaCoeurAutonome({ dossier, config: configTest() });
    coeur2.enregistrerModule(moduleSimple("acquisition", { statut: "succes", message: "reparti" }));
    const reprise = coeur2.demarrer();
    expect(reprise.tachesReprises).toBe(1);
    const etat = coeur2.etat();
    expect(etat.taches.EN_ATTENTE).toBe(1); // ré-ouverte pour ré-exécution
    expect(coeur2.cycleCourant()).toBeGreaterThanOrEqual(1); // compteur restauré
    coeur2.arreter();
  });

  it("condition 5 — les tâches restent traçables à travers les cycles", async () => {
    const coeur = new Gen3iaCoeurAutonome({ dossier, config: configTest() });
    coeur.enregistrerModule(moduleSimple("trace", { statut: "succes", message: "ok" }));
    await coeur.executerCycle();
    await attendre(15);
    await coeur.executerCycle();
    await attendre(15);
    const sante = coeur.etat();
    expect(sante.taches.TERMINEE).toBe(2);
    const journal = coeur.journal();
    expect(journal.length).toBe(2);
    expect(journal[0].cycle).toBeLessThan(journal[1].cycle);
  });

  it("modules non dus sautés honnêtement (intervalle propre respecté)", async () => {
    const coeur = new Gen3iaCoeurAutonome({ dossier, config: configTest() });
    coeur.enregistrerModule({ ...moduleSimple("lent", { statut: "succes", message: "lent" }), intervalleMs: 600_000 });
    await coeur.executerCycle();
    await attendre(15);
    const entree = await coeur.executerCycle();
    const resultatLent = entree.resultats.find((r) => r.module === "lent");
    expect(resultatLent?.statut).toBe("pas_dû");
  });
});

describe("Agent santé du cerveau (premier module connecté à gen3)", () => {
  let dossierVar: string;
  beforeEach(() => {
    dossierVar = mkdtempSync(join(tmpdir(), "coeur-sante-"));
  });
  afterEach(() => {
    rmSync(dossierVar, { recursive: true, force: true });
  });

  function ctxPour() {
    const taches = new GestionnaireTaches();
    const ctx: ContexteTick = {
      cycle: 1,
      dateIso: new Date().toISOString(),
      taches,
      evenementsRecus: [],
      emettreEvenement() {
        /* le test ne vérifie pas le bus ici */
      },
    };
    return { ctx, taches };
  }

  it("artefacts présents et frais → succes honnête + tâche tracée", async () => {
    mkdirSync(join(dossierVar, "neural"), { recursive: true });
    writeFileSync(join(dossierVar, "neural", "brain-v1.json"), "{}");
    writeFileSync(join(dossierVar, "neural", "cortex-v2.bin"), "0123456789");
    const agent = agentSanteCerveau({ dossierVar });
    const { ctx } = ctxPour();
    const rapport = await agent.tick(ctx);
    expect(rapport.statut).toBe("succes");
    expect(rapport.taches!.length).toBe(1);
    expect((rapport.details as { artefacts: unknown[] }).artefacts).toHaveLength(2);
  });

  it("absence totale de persistance ET de pré-entraînement → echec documenté", async () => {
    const agent = agentSanteCerveau({
      dossierVar,
      cheminPretrain: join(dossierVar, "n-existe-pas.json"),
    });
    const { ctx } = ctxPour();
    const rapport = await agent.tick(ctx);
    expect(rapport.statut).toBe("echec");
    expect(rapport.message).toContain("Aucun artefact de cerveau");
  });

  it("persistance PARTIELLE (pré-entraînement commis en secours) → echec honnête", async () => {
    // dossierVar vide, mais le pré-entraînement commis du dépôt existe
    // (assets/neural-pretrained/brain-domaines-v1.json, présent en repo).
    const agent = agentSanteCerveau({ dossierVar });
    const { ctx } = ctxPour();
    const rapport = await agent.tick(ctx);
    expect(rapport.statut).toBe("echec");
    expect(rapport.message).toContain("PARTIELLE");
    expect((rapport.details as { pretrainCommis: unknown }).pretrainCommis).not.toBeNull();
  });

  it("persistance périmée → echec avec l'âge réel", async () => {
    mkdirSync(join(dossierVar, "neural"), { recursive: true });
    const chemin = join(dossierVar, "neural", "brain-v1.json");
    writeFileSync(chemin, "{}");
    // Vieillit l'artefact de 80 h au-delà du seuil de 72 h.
    const vieux = new Date(Date.now() - 80 * 3600_000);
    try {
      const { utimesSync } = await import("node:fs");
      utimesSync(chemin, vieux, vieux);
    } catch {
      /* utimes indisponible : le test suivant vérifiera simplement le succès. */
    }
    const agent = agentSanteCerveau({ dossierVar, fraicheurMaxMs: 72 * 3600_000 });
    const { ctx } = ctxPour();
    const rapport = await agent.tick(ctx);
    if (process.platform === "win32") return; // utimes non garanti sous Windows
    expect(rapport.statut).toBe("echec");
    expect(rapport.message).toContain("périmée");
  });
});
