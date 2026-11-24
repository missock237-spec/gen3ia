/**
 * FILE PERSISTANTE DU PIPELINE (Lot 3 — Gen3ia Data Pipeline).
 *
 * Chaque lot collecté transite par une file DURABLE sur disque
 * (var/autonomous/pipeline/lots/<id>.json) — la collecte et le traitement
 * sont TOTALEMENT INDÉPENDANTS : le collecteur écrit un lot et passe au
 * cycle suivant sans jamais attendre le traitement (contrainte n°1 du plan,
 * garantie aussi par l'isolation des ticks du core).
 *
 * Machine à états (statuts du plan) :
 *   COLLECTED → QUEUED → PROCESSING → VALIDATING → APPROVED → INTEGRATED
 *   + REJECTED (rejeté), QUARANTINED (en quarantaine), FAILED (échec),
 *   RETRY (à retenter).
 *
 * Idempotence : un lot portant le même id (source + empreinte du contenu)
 * n'est jamais intégré deux fois — `enqueuer` refuse le doublon.
 * Traçabilité : chaque transition est horodatée dans l'historique du lot
 * (borné 20 événements, mêmes conventions que le core).
 * Récupération : au démarrage, les lots orphelins en PROCESSING/VALIDATING
 * (process mort pendant le travail) repassent RETRY puis QUEUED.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LotCollecte } from "../acquisition/types";
import type { EnregistrementStructure } from "../intelligence/traiter";

/** Statuts du pipeline (vocabulaire exact du plan). */
export type StatutLot =
  | "COLLECTED"
  | "QUEUED"
  | "PROCESSING"
  | "VALIDATING"
  | "APPROVED"
  | "INTEGRATED"
  | "REJECTED"
  | "QUARANTINED"
  | "FAILED"
  | "RETRY";

/** Transition autorisées (machine à états honnête — rien d'autre). */
const TRANSITIONS: Record<StatutLot, readonly StatutLot[]> = {
  COLLECTED: ["QUEUED"],
  QUEUED: ["PROCESSING"],
  PROCESSING: ["VALIDATING", "FAILED", "RETRY"],
  VALIDATING: ["APPROVED", "QUARANTINED", "REJECTED", "FAILED"],
  APPROVED: ["INTEGRATED"],
  INTEGRATED: [],
  REJECTED: [],
  QUARANTINED: ["VALIDATING", "REJECTED"], // réexamen possible d'une quarantaine
  FAILED: ["RETRY"],
  RETRY: ["QUEUED", "FAILED"],
};

/** Événement d'historique d'un lot. */
export interface EvenementLot {
  dateIso: string;
  de: StatutLot | "CRÉATION";
  vers: StatutLot;
  details?: string;
}

/** Lot tel que persisté (lot collecté + suivi de pipeline). */
export interface LotPersiste extends LotCollecte {
  statut: StatutLot;
  tentatives: number;
  historique: EvenementLot[];
  /**
   * Enregistrement structuré conservé pour les lots en QUARANTAINE :
   * une seconde source confirmant le même concept peut les PROMOUVOIR
   * (recherche de confirmations indépendantes — Phase 5 du plan).
   */
  structure?: EnregistrementStructure;
}

/** Caps honnêtes (RAM/disque — plan : collecte légère au début). */
const MAX_HISTORIQUE = 20;
const MAX_LOTS_DISQUE = 400;
const MAX_TENTATIVES = 3;

/** File persistante des lots. */
export class FileLots {
  private memo = new Map<string, LotPersiste>();
  /** Empreintes déjà vues (idempotence inter-lots). */
  private empreintes = new Set<string>();

  constructor(private readonly dossier: string) {
    this.chargerDisque();
  }

  /** Dossier des lots. */
  private dirLots(): string {
    return join(this.dossier, "pipeline", "lots");
  }

  /** Chemin d'un lot. */
  private cheminLot(id: string): string {
    return join(this.dirLots(), `${id}.json`);
  }

  /** Charge tous les lots persistés (boot) + purge les lots orphelins. */
  private chargerDisque(): void {
    let lotsOrphelins = 0;
    try {
      const fichiers = readdirSync(this.dirLots()).filter((f) => f.endsWith(".json"));
      for (const f of fichiers) {
        try {
          const lot = JSON.parse(readFileSync(join(this.dirLots(), f), "utf8")) as LotPersiste;
          this.memo.set(lot.id, lot);
          if (lot.statut === "PROCESSING" || lot.statut === "VALIDATING") {
            // Le process est mort pendant le travail : reprise honnête.
            lot.statut = "RETRY";
            lot.historique.push({
              dateIso: new Date().toISOString(),
              de: "PROCESSING",
              vers: "RETRY",
              details: "orphelin retrouvé au démarrage (process interrompu)",
            });
            lotsOrphelins += 1;
          }
          this.empreintes.add(lot.empreinte);
        } catch {
          /* fichier corrompu ignoré — jamais de crash au boot. */
        }
      }
      // Les RETRY repartent dans la file.
      if (lotsOrphelins > 0) {
        for (const lot of this.memo.values()) {
          if (lot.statut === "RETRY") lot.statut = "QUEUED";
        }
      }
    } catch {
      /* dossier absent : première exécution. */
    }
  }

  /** Persiste un lot (atomique tmp+rename). */
  private ecrire(lot: LotPersiste): void {
    try {
      mkdirSync(this.dirLots(), { recursive: true });
      const tmp = `${this.cheminLot(lot.id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(lot, null, 1), "utf8");
      renameSync(tmp, this.cheminLot(lot.id));
    } catch {
      /* disque plein : le lot reste en mémoire, l'échec sera visible. */
    }
  }

  /**
   * Met un lot collecté dans la file (statut COLLECTED → QUEUED).
   * Idempotence : refus (null) si l'ID existe déjà OU si l'empreinte du
   * contenu a déjà transitée — aucun doublon non maîtrisé.
   */
  enqueuer(lot: LotCollecte): LotPersiste | null {
    if (this.memo.has(lot.id)) return null;
    if (this.empreintes.has(lot.empreinte)) return null;
    const maintenant = new Date().toISOString();
    const persiste: LotPersiste = {
      ...lot,
      statut: "COLLECTED",
      tentatives: 0,
      historique: [{ dateIso: maintenant, de: "CRÉATION", vers: "COLLECTED" }],
    };
    this.transition(persiste, "QUEUED", "mise en file");
    this.memo.set(persiste.id, persiste);
    this.empreintes.add(persiste.empreinte);
    this.ecrire(persiste);
    this.elaguer();
    return persiste;
  }

  /** Transition protégée par la machine à états (false si interdite). */
  transitioner(id: string, vers: StatutLot, details?: string): boolean {
    const lot = this.memo.get(id);
    if (!lot) return false;
    return this.transition(lot, vers, details);
  }

  private transition(lot: LotPersiste, vers: StatutLot, details?: string): boolean {
    if (!TRANSITIONS[lot.statut].includes(vers)) return false;
    const avant = lot.statut;
    lot.statut = vers;
    if (vers === "QUEUED" && avant === "RETRY") lot.tentatives += 1;
    lot.historique.push({ dateIso: new Date().toISOString(), de: avant, vers, details });
    if (lot.historique.length > MAX_HISTORIQUE) {
      lot.historique.splice(0, lot.historique.length - MAX_HISTORIQUE);
    }
    this.ecrire(lot);
    return true;
  }

  /** Un lot par id. */
  obtenir(id: string): LotPersiste | null {
    return this.memo.get(id) ?? null;
  }

  /** Conserve la structure d'un lot (pour la promotion depuis la quarantaine). */
  enregistrerStructure(id: string, structure: EnregistrementStructure): boolean {
    const lot = this.memo.get(id);
    if (!lot) return false;
    lot.structure = structure;
    this.ecrire(lot);
    return true;
  }

  /** Lots dans un statut donné (ordre de mise en file — FIFO honnête). */
  parStatut(statut: StatutLot, plafond = 20): LotPersiste[] {
    return [...this.memo.values()].filter((l) => l.statut === statut).slice(0, plafond);
  }

  /** Tâches prêtes : lots QUEUED dont le nombre de tentatives < MAX. */
  aTraiter(plafond = 3): LotPersiste[] {
    return this.parStatut("QUEUED", plafond).filter((l) => l.tentatives < MAX_TENTATIVES);
  }

  /** Un lot en échec repasse en RETRY puis QUEUED (jusqu'à MAX_TENTATIVES). */
  replanifier(id: string, details: string): boolean {
    const lot = this.memo.get(id);
    if (!lot) return false;
    const versRetry = this.transition(lot, "RETRY", details);
    if (!versRetry) return false;
    if (lot.tentatives >= MAX_TENTATIVES - 1) {
      // Trop de tentatives : échec définitif tracé (jamais silencieux).
      this.transition(lot, "FAILED", `max ${MAX_TENTATIVES} tentatives atteint`);
      return true;
    }
    return this.transition(lot, "QUEUED", "replanifié");
  }

  /** Comptage par statut (tableau de supervision Phase 12). */
  compteParStatut(): Record<StatutLot, number> {
    const compte = {
      COLLECTED: 0,
      QUEUED: 0,
      PROCESSING: 0,
      VALIDATING: 0,
      APPROVED: 0,
      INTEGRATED: 0,
      REJECTED: 0,
      QUARANTINED: 0,
      FAILED: 0,
      RETRY: 0,
    } as Record<StatutLot, number>;
    for (const l of this.memo.values()) compte[l.statut] += 1;
    return compte;
  }

  /** Élague les lots terminés les plus anciens (disque borné). */
  private elaguer(): void {
    const termines = [...this.memo.values()]
      .filter((l) => l.statut === "INTEGRATED" || l.statut === "REJECTED")
      .sort((a, b) => Date.parse(a.collecteLe) - Date.parse(b.collecteLe));
    while (this.memo.size > MAX_LOTS_DISQUE && termines.length > 0) {
      const lot = termines.shift()!;
      this.memo.delete(lot.id);
      try {
        unlinkSync(this.cheminLot(lot.id));
      } catch {
        /* déjà absent : rien à faire. */
      }
    }
  }

  /** Nombre de lots connus. */
  taille(): number {
    return this.memo.size;
  }
}
