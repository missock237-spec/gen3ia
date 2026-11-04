import { ORDRE_GRAVITE, SIGNATURES_PANNE, type SignaturePanne } from "./signatures";

/**
 * AGENTS-OS — ANALYSEUR D'ERREURS PAR SIGNATURES (Module 1 : auto-guérison).
 *
 * Applique le catalogue de signatures ligne à ligne et applique DEUX garde-fous
 * anti-tempête avant de déclarer une panne « à remédier » :
 *
 *   1. DÉDUPLICATION — une même empreinte (signature × fichier) est fenêtrée :
 *      les occurrences redondantes (le même motif répété sur des milliers de
 *      lignes de log) ne comptent qu'une fois par fenêtre ;
 *   2. SEUIL — la panne n'est déclarée qu'au N-ième compte distinct dans la
 *      fenêtre (une ligne isolée ne déclenche pas de remédiation).
 *
 * 100 % déterministe : regex pures, aucune dépendance réseau ni LLM.
 */

export interface Detection {
  /** Identifiant de la signature assortie. */
  readonly signatureId: string;
  /** La signature complète (cause, gravité, action déclarée). */
  readonly signature: SignaturePanne;
  /** Ligne de log brute qui a déclenché (première occurrence du lot). */
  readonly extrait: string;
  /** Fichier source. */
  readonly fichier: string;
  /** Nombre d'occurrences du lot pour cette signature. */
  readonly occurrences: number;
  /** Le seuil est atteint : la panne est déclarée. */
  readonly declaree: boolean;
}

export interface ConfigAnalyseur {
  /** Fenêtre de déduplication (ms, défaut 120 000 = 2 min). */
  readonly fenetreMs?: number;
  /** Occurrences distinctes nécessaires pour déclarer (défaut 2). */
  readonly seuil?: number;
  /** Capacité du cache d'empreintes (anti-fuite mémoire, défaut 2 048). */
  readonly capaciteCache?: number;
}

/** État interne d'une empreinte : comptes distincts horodatés. */
interface Empreinte {
  dernierEpochMs: number;
  comptesDansFenetre: number;
}

export class AnalyseurErreurs {
  private readonly empreintes = new Map<string, Empreinte>();
  private readonly fenetreMs: number;
  private readonly seuil: number;
  private readonly capaciteCache: number;

  constructor(config: ConfigAnalyseur = {}) {
    this.fenetreMs = config.fenetreMs ?? 120_000;
    this.seuil = Math.max(1, config.seuil ?? 2);
    this.capaciteCache = config.capaciteCache ?? 2_048;
  }

  /**
   * Analyse un lot de lignes. Retourne UNE détection par signature rencontrée
   * dans le lot (agrégée), `declaree` indiquant si le seuil est franchi.
   */
  analyser(lots: readonly { fichier: string; ligne: string; epochMs: number }[]): Detection[] {
    // Agrégation par signature sur le lot (une seule détection par signature
    // même si 1 000 lignes la contiennent — l'action reste unique).
    const parSignature = new Map<string, { signature: SignaturePanne; extrait: string; fichier: string; occurrences: number; epochMs: number }>();

    for (const entree of lots) {
      for (const signature of SIGNATURES_PANNE) {
        if (!signature.motif.test(entree.ligne)) continue;
        const existante = parSignature.get(signature.id);
        if (existante) {
          existante.occurrences += 1;
        } else {
          parSignature.set(signature.id, {
            signature,
            extrait: entree.ligne.slice(0, 300),
            fichier: entree.fichier,
            occurrences: 1,
            epochMs: entree.epochMs,
          });
        }
        break; // une ligne = au plus une signature (la première du catalogue)
      }
    }

    const detections: Detection[] = [];
    for (const { signature, extrait, fichier, occurrences, epochMs } of parSignature.values()) {
      const declaree = this.compterEtDecider(signature.id, fichier, epochMs);
      detections.push({ signatureId: signature.id, signature, extrait, fichier, occurrences, declaree });
    }

    // Gravité décroissante : les critiques d'abord (journal lisible).
    detections.sort((a, b) => ORDRE_GRAVITE[b.signature.gravite] - ORDRE_GRAVITE[a.signature.gravite]);
    return detections;
  }

  /**
   * Compte DÉDUPLIQUÉ par empreinte (signature × fichier) : incrémenté une
   * fois par lot, purgé de la fenêtre glissante, comparé au seuil.
   */
  private compterEtDecider(signatureId: string, fichier: string, epochMs: number): boolean {
    const cle = `${signatureId}::${fichier}`;
    const existante = this.empreintes.get(cle);

    if (!existante || epochMs - existante.dernierEpochMs > this.fenetreMs) {
      // Nouvelle fenêtre : on repart de 1.
      this.purgerSiSature();
      this.empreintes.set(cle, { dernierEpochMs: epochMs, comptesDansFenetre: 1 });
      return this.seuil <= 1;
    }

    existante.dernierEpochMs = epochMs;
    existante.comptesDansFenetre += 1;
    return existante.comptesDansFenetre >= this.seuil;
  }

  /** Anti-fuite : quand le cache sature, on évacue les empreintes expirées
   *  puis, si besoin, la plus ancienne (politique LRU naïve suffisante). */
  private purgerSiSature(): void {
    if (this.empreintes.size < this.capaciteCache) return;
    const maintenant = Date.now();
    for (const [cle, empreinte] of this.empreintes) {
      if (maintenant - empreinte.dernierEpochMs > this.fenetreMs) this.empreintes.delete(cle);
    }
    if (this.empreintes.size >= this.capaciteCache) {
      const premiere = this.empreintes.keys().next().value;
      if (premiere !== undefined) this.empreintes.delete(premiere);
    }
  }

  /** Réinitialise l'état (tests, remise à zéro manuelle). */
  reinitialiser(): void {
    this.empreintes.clear();
  }
}
