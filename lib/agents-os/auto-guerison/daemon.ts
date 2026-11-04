import * as path from "node:path";

import { ObservateurLogs, type SourceLog } from "./observateur-logs";
import { AnalyseurErreurs } from "./analyseur-erreurs";
import { Remediateur, repertoireJournalParDefaut } from "./remediateur";
import type { NiveauAction } from "./signatures";

/**
 * AGENTS-OS — DAEMON D'AUTO-GUÉRISON (Module 1 : Master Daemon observateur).
 *
 * Orchestrateur : sources de logs → observateur → analyseur → remédiateur.
 * Processus LONG (PM2 fork) — lancé EXPLICITEMENT, jamais au boot Next :
 *
 *   pm2 start infra/agents-os/ecosystem.daemon.config.js
 *   # ou manuellement :
 *   npx tsx lib/agents-os/auto-guerison/daemon.ts
 *
 * CONFIGURATION (variables d'environnement, toutes optionnelles) :
 *   AGENTS_OS_LOGS            liste « chemin[:intervalleMs] » séparée par des
 *                             virgules (défaut : ~/.pm2/logs/*-out.log sauf
 *                             si PM2_HOME absent → var/agents-os/demo.log).
 *   AGENTS_OS_NIVEAU          niveau d'action armé : diagnostic (défaut) |
 *                             commande | pm2 | docker.
 *   AGENTS_OS_SEUIL           occurrences distinctes avant déclaration (déf. 2).
 *   AGENTS_OS_FENETRE_MS      fenêtre de déduplication (défaut 120 000).
 *   AGENTS_OS_COOLDOWN_MS     cooldown par signature (défaut 600 000).
 *   AGENTS_OS_ETAT_DIR        répertoire du journal (défaut var/agents-os).
 *   AGENTS_OS_SERVICE         service par défaut pour {{service}}.
 *
 * La sonde GET /api/v1/agents-os/daemon expose le journal sans SSH.
 */

export interface ConfigDaemon {
  readonly sources: readonly SourceLog[];
  readonly niveauArme: NiveauAction;
  readonly seuil: number;
  readonly fenetreMs: number;
  readonly cooldownMs: number;
  readonly repertoireJournal: string;
  readonly serviceParDefaut?: string;
}

/** Config dérivée de l'environnement (daemon réellement déployé). */
export function configDepuisEnvironnement(env: NodeJS.ProcessEnv = process.env): ConfigDaemon {
  const sources: SourceLog[] = env.AGENTS_OS_LOGS
    ? env.AGENTS_OS_LOGS.split(",")
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const [chemin, intervalle] = chunk.split(":");
          return { chemin: path.resolve(chemin), intervalleMs: intervalle ? Number(intervalle) : undefined };
        })
    : sourcesParDefaut(env);

  const niveaux: NiveauAction[] = ["diagnostic", "commande", "pm2", "docker"];
  const niveauArme = niveaux.includes(env.AGENTS_OS_NIVEAU as NiveauAction)
    ? (env.AGENTS_OS_NIVEAU as NiveauAction)
    : "diagnostic";

  return {
    sources,
    niveauArme,
    seuil: nombre(env.AGENTS_OS_SEUIL, 2),
    fenetreMs: nombre(env.AGENTS_OS_FENETRE_MS, 120_000),
    cooldownMs: nombre(env.AGENTS_OS_COOLDOWN_MS, 600_000),
    repertoireJournal: env.AGENTS_OS_ETAT_DIR ? path.resolve(env.AGENTS_OS_ETAT_DIR) : repertoireJournalParDefaut(),
    serviceParDefaut: env.AGENTS_OS_SERVICE,
  };
}

function nombre(brut: string | undefined, defaut: number): number {
  const n = brut ? Number(brut) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaut;
}

/** Sources par défaut : les logs PM2 de l'hôte (hors daemon lui-même). */
function sourcesParDefaut(env: NodeJS.ProcessEnv): SourceLog[] {
  const homePm2 = env.PM2_HOME ?? path.join(env.HOME ?? "/root", ".pm2");
  const repLogs = path.join(homePm2, "logs");
  const noms = ["gen3ia-out.log", "gen3ia-error.log", "worker-out.log", "worker-error.log"];
  return noms.map((nom) => ({ chemin: path.join(repLogs, nom), intervalleMs: 2_000 }));
}

/**
 * DaemonAutoGuerison — classe réutilisable (tests : injecter des sources
 * temporaires et un intervalle court) et point d'entrée CLI.
 */
export class DaemonAutoGuerison {
  private readonly observateur: ObservateurLogs;
  private readonly analyseur: AnalyseurErreurs;
  private readonly remediateur: Remediateur;

  constructor(private readonly config: ConfigDaemon) {
    this.observateur = new ObservateurLogs(config.sources);
    this.analyseur = new AnalyseurErreurs({ seuil: config.seuil, fenetreMs: config.fenetreMs });
    this.remediateur = new Remediateur({
      niveauArme: config.niveauArme,
      cooldownMs: config.cooldownMs,
      repertoireJournal: config.repertoireJournal,
      serviceParDefaut: config.serviceParDefaut,
    });
  }

  /** Démarre la boucle de surveillance. Retourne la fonction d'arrêt. */
  demarrer(): () => void {
    this.observateur.demarrer(
      (lignes) => {
        const detections = this.analyseur.analyser(lignes);
        for (const detection of detections) {
          if (!detection.declaree) continue;
          // Fire-and-forget maîtrisé : la remédiation se journalise elle-même.
          void this.remediateur.remedier(detection);
        }
      },
      (erreur, chemin) => {
        // Source illisible : bruit volontairement muet (fichier pas encore
        // créé) — seule une vraie erreur I/O d'un fichier existant intéresse
        // la télémétrie ; elle passe par le journal du remédiateur côté stop.
        void erreur;
        void chemin;
      },
    );
    return () => this.observateur.arreter();
  }

  /** Journal des remédiations (sonde). */
  journal(limite = 50): unknown[] {
    return this.remediateur.lireJournal(limite);
  }
}

/* --------------------------- Point d'entrée CLI --------------------------- */

if (process.argv[1] && process.argv[1].endsWith("daemon.ts")) {
  const config = configDepuisEnvironnement();
  const daemon = new DaemonAutoGuerison(config);
  daemon.demarrer();
  // Signaux de vie honnêtes sur stdout (PM2 les capture dans *-out.log).
  console.log(
    JSON.stringify({
      ok: true,
      daemon: "agents-os/auto-guerison",
      ts: new Date().toISOString(),
      niveauArme: config.niveauArme,
      sources: config.sources.map((s) => s.chemin),
    }),
  );
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
