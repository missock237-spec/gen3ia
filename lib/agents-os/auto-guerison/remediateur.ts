import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { Detection } from "./analyseur-erreurs";
import type { NiveauAction } from "./signatures";

/**
 * AGENTS-OS — REMÉDIATEUR (Module 1 : auto-guérison).
 *
 * Exécute l'action déclarée d'une signature DETECTÉE, sous QUATRE garde-fous :
 *
 *   1. HIÉRARCHIE — le niveau d'action demandé doit être armé dans la config
 *      (défaut : "diagnostic" seul — le daemon observe et journalise sans
 *      muter le système) ;
 *   2. COOLDOWN — une même signature ne peut pas être remédiée plus d'une
 *      fois par période (anti-boucle : pas de restart en rafale) ;
 *   3. ARGUMENTS FIXES — les commandes sont des argv déclaratifs ; le seul
 *      substitut possible est `{{service}}`, rempli depuis le groupe de
 *      capture nommé `service` du motif OU la config — JAMAIS depuis la
 *      ligne de log brute (anti-injection) ;
 *   4. TIMEOUT — tout processus de remédiation est tué après le délai.
 *
 * Chaque action (même refusée) est journalisée en JSONL horodaté, consommé
 * par la sonde GET /api/v1/agents-os/daemon.
 */

export interface ConfigRemediateur {
  /** Niveau d'action maximal armé (défaut "diagnostic"). */
  readonly niveauArme?: NiveauAction;
  /** Cooldown par signature en ms (défaut 10 min). */
  readonly cooldownMs?: number;
  /** Timeout d'exécution d'une remédiation en ms (défaut 60 000). */
  readonly timeoutMs?: number;
  /** Répertoire du journal JSONL (défaut var/agents-os). */
  readonly repertoireJournal?: string;
  /** Nom du fichier journal (défaut remediation.jsonl). */
  readonly nomJournal?: string;
  /** Service par défaut pour les placeholders {{service}} non capturés. */
  readonly serviceParDefaut?: string;
}

export interface ResultatRemediation {
  readonly signatureId: string;
  readonly niveauDemande: NiveauAction;
  readonly niveauArme: NiveauAction;
  readonly executee: boolean;
  readonly refus?: "niveau-non-arme" | "cooldown" | "aucune-action-declaree" | "service-non-identifie";
  readonly commande?: readonly string[];
  readonly codeSortie?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly dureeMs: number;
  readonly epochMs: number;
  readonly erreur?: string;
}

/** Chemin absolu par défaut du répertoire d'état (relatif au projet). */
export function repertoireJournalParDefaut(): string {
  return path.join(process.cwd(), "var", "agents-os");
}

export class Remediateur {
  private readonly niveauArme: NiveauAction;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly cheminJournal: string;
  private readonly serviceParDefaut?: string;
  /** Dernière exécution réussie par signature (epoch ms) — mémoire volatile :
   *  le daemon PM2 vit longtemps ; après redémarrage du daemon, le cooldown
   *  repart de zéro, acceptable (le journal garde la trace historique). */
  private readonly dernieresActions = new Map<string, number>();

  constructor(config: ConfigRemediateur = {}) {
    const hierarchie: NiveauAction[] = ["diagnostic", "commande", "pm2", "docker"];
    const demande = config.niveauArme ?? "diagnostic";
    this.niveauArme = hierarchie.includes(demande) ? demande : "diagnostic";
    this.cooldownMs = Math.max(0, config.cooldownMs ?? 600_000);
    this.timeoutMs = Math.max(1_000, config.timeoutMs ?? 60_000);
    const repertoire = config.repertoireJournal ?? repertoireJournalParDefaut();
    fs.mkdirSync(repertoire, { recursive: true });
    this.cheminJournal = path.join(repertoire, config.nomJournal ?? "remediation.jsonl");
    this.serviceParDefaut = config.serviceParDefaut;
  }

  /** Chemin du journal JSONL (sonde de statut). */
  get journal(): string {
    return this.cheminJournal;
  }

  /**
   * Traite une détection déclarée : décide, exécute, journalise.
   * Ne lève JAMAIS — toute exception devient un résultat d'échec journalisé.
   */
  async remedier(detection: Detection): Promise<ResultatRemediation> {
    const epochMs = Date.now();
    const base: Omit<ResultatRemediation, "executee" | "dureeMs" | "epochMs"> = {
      signatureId: detection.signatureId,
      niveauDemande: detection.signature.niveau,
      niveauArme: this.niveauArme,
    };

    // Garde-fou 1 : niveau non armé → diagnostic journalisé, rien d'autre.
    if (!this.niveauAutorise(detection.signature.niveau)) {
      return this.conclure({ ...base, executee: false, refus: "niveau-non-arme", dureeMs: 0, epochMs });
    }

    // Garde-fou 2 : cooldown par signature.
    const precedente = this.dernieresActions.get(detection.signatureId);
    if (precedente !== undefined && epochMs - precedente < this.cooldownMs) {
      return this.conclure({ ...base, executee: false, refus: "cooldown", dureeMs: 0, epochMs });
    }

    const action = detection.signature.action;
    if (!action) {
      return this.conclure({ ...base, executee: false, refus: "aucune-action-declaree", dureeMs: 0, epochMs });
    }

    // Construction argv (garde-fou 3) — jamais de shell string concaténé
    // depuis les logs.
    let argv: string[];
    if (action.commande) {
      argv = [...action.commande];
    } else if (action.gestionnaire === "pm2") {
      const service = this.resoudreService(detection, action.service);
      if (!service) {
        return this.conclure({ ...base, executee: false, refus: "service-non-identifie", dureeMs: 0, epochMs });
      }
      argv = ["pm2", "restart", ...(action.args ?? []), service];
    } else if (action.gestionnaire === "docker") {
      const service = this.resoudreService(detection, action.service);
      if (!service) {
        return this.conclure({ ...base, executee: false, refus: "service-non-identifie", dureeMs: 0, epochMs });
      }
      argv = ["docker", "restart", ...(action.args ?? []), service];
    } else {
      return this.conclure({ ...base, executee: false, refus: "aucune-action-declaree", dureeMs: 0, epochMs });
    }

    // Garde-fou 4 : exécution plafonnée.
    const debut = Date.now();
    try {
      const resultat = await this.executer(argv);
      const dureeMs = Date.now() - debut;
      const conclue: ResultatRemediation = {
        ...base,
        executee: true,
        commande: argv,
        codeSortie: resultat.code,
        signal: resultat.signal,
        stdout: resultat.stdout.slice(0, 2_000),
        stderr: resultat.stderr.slice(0, 2_000),
        dureeMs,
        epochMs,
      };
      this.dernieresActions.set(detection.signatureId, epochMs);
      return this.conclure(conclue);
    } catch (erreur) {
      const dureeMs = Date.now() - debut;
      // Une remédiation TENTÉE compte dans le cooldown (anti-boucle) : un
      // échec d'exécution ne doit pas déclencher des tentatives en rafale.
      this.dernieresActions.set(detection.signatureId, epochMs);
      return this.conclure({
        ...base,
        executee: false,
        commande: argv,
        refus: undefined,
        dureeMs,
        epochMs,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  }

  /** Lit les N dernières entrées du journal (sonde de statut). */
  lireJournal(limite = 50): unknown[] {
    try {
      if (!fs.existsSync(this.cheminJournal)) return [];
      const texte = fs.readFileSync(this.cheminJournal, "utf8").trim();
      if (!texte) return [];
      const lignes = texte.split("\n").slice(-limite);
      const entrees: unknown[] = [];
      for (const ligne of lignes) {
        try {
          entrees.push(JSON.parse(ligne));
        } catch {
          // Ligne partielle (écriture interrompue) : ignorée, jamais crash.
        }
      }
      return entrees;
    } catch {
      return [];
    }
  }

  private niveauAutorise(demande: NiveauAction): boolean {
    const hierarchie: NiveauAction[] = ["diagnostic", "commande", "pm2", "docker"];
    return hierarchie.indexOf(demande) <= hierarchie.indexOf(this.niveauArme);
  }

  /** Résout {{service}} : capture nommée `service` du motif, sinon config,
   *  sinon refus. Validé contre une grammaire stricte de noms de services. */
  private resoudreService(detection: Detection, gabarit?: string): string | null {
    // Extraction depuis l'extrait de log : groupe nommé `service` s'il existe.
    let capture: string | null = null;
    const motif = detection.signature.motif;
    const groupes = motif.exec(detection.extrait);
    if (groupes?.groups?.service) capture = groupes.groups.service.trim();

    const service = gabarit && gabarit !== "{{service}}" ? gabarit : (capture ?? this.serviceParDefaut ?? null);
    if (!service) return null;
    // Grammaire stricte : lettres, chiffres, tirets, underscores, points —
    // rejette tout espace, slash, $, backtick, etc.
    return /^[A-Za-z0-9_.-]{1,64}$/.test(service) ? service : null;
  }

  /** Spawn plafonné : timeout → SIGTERM → grâce 3 s → SIGKILL. */
  private executer(argv: readonly string[]): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
    return new Promise((resoudre, rejeter) => {
      // Typage explicite ChildProcess (cf. executeur-sandbox.ts — TS 6).
      const enfant: ChildProcess = spawn(argv[0], argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      });

      let stdout = "";
      let stderr = "";
      let fini = false;
      const debut = Date.now();

      // stdio "pipe" garanti non nul à la création — garde défensive ?.
      enfant.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < 4_000) stdout += d.toString("utf8");
      });
      enfant.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < 4_000) stderr += d.toString("utf8");
      });

      const minuteur = setTimeout(() => {
        if (fini) return;
        enfant.kill("SIGTERM");
        setTimeout(() => {
          if (!fini) enfant.kill("SIGKILL");
        }, 3_000);
      }, this.timeoutMs);
      minuteur.unref?.();

      enfant.on("error", (erreur) => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        rejeter(erreur);
      });

      enfant.on("close", (code, signal) => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        resoudre({ code, signal, stdout, stderr, dureeMs: Date.now() - debut } as { code: number | null; signal: string | null; stdout: string; stderr: string });
      });
    });
  }

  /** Journalise (JSONL append, best-effort) puis retourne le résultat. */
  private conclure(resultat: ResultatRemediation): ResultatRemediation {
    try {
      fs.appendFileSync(this.cheminJournal, JSON.stringify(resultat) + "\n", "utf8");
    } catch {
      // Journal indisponible (disque plein…) : la remédiation prime.
    }
    return resultat;
  }
}
