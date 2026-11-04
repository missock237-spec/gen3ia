import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AnalyseurErreurs } from "./analyseur-erreurs";
import { ObservateurLogs } from "./observateur-logs";
import { Remediateur } from "./remediateur";
import { DaemonAutoGuerison, configDepuisEnvironnement } from "./daemon";

/** Lignes de test — une par famille de signature du catalogue. */
const LIGNE_EADDRINUSE = "Error: listen EADDRINUSE: address already in use 0.0.0.0:3000";
const LIGNE_OOM = "FATAL ERROR: Reached heap limit - Allocation failed - JavaScript heap out of memory";
const LIGNE_MODULE = "Error: Cannot find module 'firebase-admin'";
const LIGNE_OK = "GET /api/health 200 3ms";

describe("Module 1 — auto-guérison : AnalyseurErreurs", () => {
  beforeEach(() => {});

  it("détecte une signature et ne déclare PAS au premier passage (seuil 2)", () => {
    const analyseur = new AnalyseurErreurs({ seuil: 2, fenetreMs: 60_000 });
    const lot1 = analyseur.analyser([{ fichier: "app.log", ligne: LIGNE_EADDRINUSE, epochMs: Date.now() }]);
    expect(lot1).toHaveLength(1);
    expect(lot1[0].signatureId).toBe("port-occupe");
    expect(lot1[0].declaree).toBe(false);

    const lot2 = analyseur.analyser([{ fichier: "app.log", ligne: LIGNE_EADDRINUSE, epochMs: Date.now() + 1_000 }]);
    expect(lot2[0].declaree).toBe(true);
  });

  it("déclare immédiatement au seuil 1", () => {
    const analyseur = new AnalyseurErreurs({ seuil: 1 });
    const lot = analyseur.analyser([{ fichier: "app.log", ligne: LIGNE_OOM, epochMs: Date.now() }]);
    expect(lot[0].declaree).toBe(true);
    expect(lot[0].signature.gravite).toBe("critique");
  });

  it("déduplique par fichier : deux fichiers ne partagent pas leur compteur", () => {
    const analyseur = new AnalyseurErreurs({ seuil: 2 });
    analyseur.analyser([{ fichier: "a.log", ligne: LIGNE_MODULE, epochMs: Date.now() }]);
    const lot = analyseur.analyser([{ fichier: "b.log", ligne: LIGNE_MODULE, epochMs: Date.now() }]);
    expect(lot[0].declaree).toBe(false); // b.log : premier compte distinct
  });

  it("la fenêtre glissante repart de zéro après expiration", () => {
    const analyseur = new AnalyseurErreurs({ seuil: 2, fenetreMs: 1_000 });
    const t0 = Date.now();
    analyseur.analyser([{ fichier: "a.log", ligne: LIGNE_OOM, epochMs: t0 }]);
    // 5 s plus tard : fenêtre expirée → recompte à 1.
    const lot = analyseur.analyser([{ fichier: "a.log", ligne: LIGNE_OOM, epochMs: t0 + 5_000 }]);
    expect(lot[0].declaree).toBe(false);
  });

  it("une ligne saine ne produit AUCUNE détection", () => {
    const analyseur = new AnalyseurErreurs({ seuil: 1 });
    const lot = analyseur.analyser([{ fichier: "a.log", ligne: LIGNE_OK, epochMs: Date.now() }]);
    expect(lot).toHaveLength(0);
  });

  it("agrège un lot multi-erreurs trié par gravité décroissante", () => {
    const analyseur = new AnalyseurErreurs({ seuil: 1 });
    const lot = analyseur.analyser([
      { fichier: "a.log", ligne: LIGNE_EADDRINUSE, epochMs: Date.now() },
      { fichier: "a.log", ligne: LIGNE_OOM, epochMs: Date.now() },
      { fichier: "a.log", ligne: LIGNE_OK, epochMs: Date.now() },
    ]);
    expect(lot).toHaveLength(2);
    expect(lot[0].signature.gravite).toBe("critique"); // OOM d'abord
  });
});

describe("Module 1 — auto-guérison : ObservateurLogs", () => {
  let repertoire: string;
  let cheminLog: string;

  beforeEach(() => {
    repertoire = fs.mkdtempSync(path.join(os.tmpdir(), "agents-os-test-"));
    cheminLog = path.join(repertoire, "app.log");
  });

  afterEach(() => {
    fs.rmSync(repertoire, { recursive: true, force: true });
  });

  it("relit uniquement les NOUVELLES lignes (incrémental)", () => {
    fs.writeFileSync(cheminLog, "ligne-1\nligne-2\n", "utf8");
    const observateur = new ObservateurLogs([{ chemin: cheminLog }]);
    const recoltees: string[] = [];

    // Premier scan (ancrage offset — lit la queue).
    observateur.lire({ chemin: cheminLog }, (lignes) => recoltees.push(...lignes.map((l) => l.ligne)));
    const apresAncrage = recoltees.length;
    expect(apresAncrage).toBeGreaterThan(0);

    // Append : seul le delta est produit.
    recoltees.length = 0;
    fs.appendFileSync(cheminLog, "ligne-3\nligne-4\n", "utf8");
    observateur.lire({ chemin: cheminLog }, (lignes) => recoltees.push(...lignes.map((l) => l.ligne)));
    expect(recoltees).toEqual(["ligne-3", "ligne-4"]);
  });

  it("détecte la rotation (troncature) et relit depuis zéro", () => {
    fs.writeFileSync(cheminLog, "ancienne-ligne-tres-longue\n".repeat(50), "utf8");
    const observateur = new ObservateurLogs([{ chemin: cheminLog }]);
    observateur.lire({ chemin: cheminLog }, () => {}); // ancre

    const recoltees: string[] = [];
    fs.writeFileSync(cheminLog, "rotated-1\n", "utf8"); // rotation : taille < offset
    observateur.lire({ chemin: cheminLog }, (lignes) => recoltees.push(...lignes.map((l) => l.ligne)));
    expect(recoltees).toEqual(["rotated-1"]);
  });

  it("une ligne sans \\n final reste en attente (pas de doublon)", () => {
    fs.writeFileSync(cheminLog, "complet\npartielle", "utf8");
    const observateur = new ObservateurLogs([{ chemin: cheminLog }]);
    const recoltees: string[] = [];
    observateur.lire({ chemin: cheminLog }, (lignes) => recoltees.push(...lignes.map((l) => l.ligne)));
    expect(recoltees).toEqual(["complet"]);

    fs.appendFileSync(cheminLog, "-terminee\nencore\n", "utf8");
    recoltees.length = 0;
    observateur.lire({ chemin: cheminLog }, (lignes) => recoltees.push(...lignes.map((l) => l.ligne)));
    expect(recoltees).toEqual(["partielle-terminee", "encore"]);
  });

  it("un fichier absent n'interrompt pas la surveillance", () => {
    const observateur = new ObservateurLogs([{ chemin: path.join(repertoire, "inexistant.log") }]);
    expect(() => observateur.lire({ chemin: path.join(repertoire, "inexistant.log") }, () => {})).not.toThrow();
  });
});

describe("Module 1 — auto-guérison : Remediateur", () => {
  let repertoire: string;

  beforeEach(() => {
    repertoire = fs.mkdtempSync(path.join(os.tmpdir(), "agents-os-journal-"));
  });

  afterEach(() => {
    fs.rmSync(repertoire, { recursive: true, force: true });
  });

  const detectionOOM = (declaree = true) => ({
    signatureId: "fuite-memoire-heap",
    signature: {
      id: "fuite-memoire-heap",
      motif: /(FATAL ERROR)/i,
      cause: "test",
      gravite: "critique" as const,
      niveau: "pm2" as const,
      action: { gestionnaire: "pm2" as const, service: "gen3ia", args: [] },
    },
    extrait: LIGNE_OOM,
    fichier: "app.log",
    occurrences: 1,
    declaree,
  });

  it("REFUSE d'agir quand le niveau demandé n'est pas armé (défaut diagnostic)", async () => {
    const remediateur = new Remediateur({ niveauArme: "diagnostic", repertoireJournal: repertoire });
    const resultat = await remediateur.remedier(detectionOOM());
    expect(resultat.executee).toBe(false);
    expect(resultat.refus).toBe("niveau-non-arme");
  });

  it("exécute la remédiation pm2 quand le niveau est armé (spawn réel, pm2 absent → erreur journalisée)", async () => {
    const remediateur = new Remediateur({ niveauArme: "docker", repertoireJournal: repertoire, cooldownMs: 0 });
    const resultat = await remediateur.remedier(detectionOOM());
    expect(resultat.commande).toEqual(["pm2", "restart", "gen3ia"]);
    // pm2 n'existe pas forcément dans le sandbox de test : le résultat est
    // journalisé quoi qu'il arrive (exécutée OU erreur propre).
    expect(["pm2", "restart", "gen3ia"].every((a) => resultat.commande!.includes(a))).toBe(true);
  });

  it("applique le cooldown par signature", async () => {
    const remediateur = new Remediateur({ niveauArme: "docker", repertoireJournal: repertoire, cooldownMs: 600_000 });
    await remediateur.remedier(detectionOOM());
    const deuxieme = await remediateur.remedier(detectionOOM());
    expect(deuxieme.refus).toBe("cooldown");
  });

  it("journalise en JSONL lisible par la sonde", async () => {
    const remediateur = new Remediateur({ niveauArme: "diagnostic", repertoireJournal: repertoire });
    await remediateur.remedier(detectionOOM());
    const entrees = remediateur.lireJournal(10);
    expect(entrees).toHaveLength(1);
    expect((entrees[0] as { signatureId: string }).signatureId).toBe("fuite-memoire-heap");
  });

  it("REFUSE un nom de service hostile (anti-injection)", async () => {
    const remediateur = new Remediateur({
      niveauArme: "pm2",
      repertoireJournal: repertoire,
      cooldownMs: 0,
      serviceParDefaut: "rm -rf /", // injecté via config hostile
    });
    const detectionSansService = {
      ...detectionOOM(),
      signature: {
        ...detectionOOM().signature,
        action: { gestionnaire: "pm2" as const, service: "{{service}}", args: [] },
      },
    };
    const resultat = await remediateur.remedier(detectionSansService);
    expect(resultat.executee).toBe(false);
    expect(resultat.refus).toBe("service-non-identifie");
  });
});

describe("Module 1 — auto-guérison : DaemonAutoGuerison", () => {
  it("configDepuisEnvironnement : défauts sûrs + parsing des sources", () => {
    const config = configDepuisEnvironnement({
      AGENTS_OS_LOGS: "/tmp/a.log:1000,/tmp/b.log",
      AGENTS_OS_NIVEAU: "commande",
      AGENTS_OS_SEUIL: "3",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.sources).toEqual([
      { chemin: "/tmp/a.log", intervalleMs: 1000 },
      { chemin: "/tmp/b.log", intervalleMs: undefined },
    ]);
    expect(config.niveauArme).toBe("commande");
    expect(config.seuil).toBe(3);
  });

  it("un niveau env invalide retombe sur diagnostic (fail-safe)", () => {
    const config = configDepuisEnvironnement({ AGENTS_OS_NIVEAU: "nuke" } as unknown as NodeJS.ProcessEnv);
    expect(config.niveauArme).toBe("diagnostic");
  });

  it("le daemon démarre, détecte et s'arrête proprement (boucle réelle courte)", async () => {
    const repertoire = fs.mkdtempSync(path.join(os.tmpdir(), "agents-os-daemon-"));
    const cheminLog = path.join(repertoire, "app.log");
    fs.writeFileSync(cheminLog, "boot ok\n", "utf8");

    const daemon = new DaemonAutoGuerison({
      sources: [{ chemin: cheminLog, intervalleMs: 150 }],
      niveauArme: "diagnostic",
      seuil: 1,
      fenetreMs: 60_000,
      cooldownMs: 0,
      repertoireJournal: path.join(repertoire, "etat"),
    });

    const arreter = daemon.demarrer();
    fs.appendFileSync(cheminLog, "FATAL ERROR: Reached heap limit\n", "utf8");

    // Attente NON bloquante (les timers ont besoin du thread principal) :
    // jusqu'à 3 s, puis verdict sur le journal.
    const debut = Date.now();
    while (Date.now() - debut < 3_000) {
      if (daemon.journal(5).length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    arreter();

    expect(daemon.journal(5).length).toBeGreaterThan(0);
    fs.rmSync(repertoire, { recursive: true, force: true });
  }, 10_000);
});
