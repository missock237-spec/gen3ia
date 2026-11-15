import "server-only";

/**
 * REGISTRE CENTRAL DE L'ESSAIM MÉDIA — la mémoire des appareils.
 *
 * L'IA centrale tient ici la liste des agents gen3 vivants (un par
 * navigateur connecté), leurs capacités GPU, leur charge et leur onde
 * de vie (battements). C'est à partir de ce registre que la sélection
 * « des 5 meilleurs appareils avec une bonne carte graphique » est
 * opérée à chaque job (BORNES_ESSAIM.équipeMax).
 *
 * Honnêteté d'ingénierie : le registre vit en mémoire du process Node
 * (PM2 gen3ia, 1 instance). Un redémarrage vide la table — chaque agent
 * re-annonce ses ondes dans les 12 s, l'essaim se reconstitue seul.
 * Le module est testable : l'horloge est injectable.
 */

import {
  BORNES_ESSAIM,
  scoreNoeud,
  type CapacitésNoeud,
  type NoeudEssaim,
} from "./types";

export interface ÉtatEssaim {
  noeudsEnLigne: number;
  noeudsTotal: number;
  top: Array<{
    noeudId: string;
    adaptateur: string;
    memoireGo: number;
    score: number;
    charge: number;
    succès: number;
    âgeBattementMs: number;
  }>;
}

export class RegistreEssaim {
  private noeuds = new Map<string, NoeudEssaim>();
  private maintenant: () => number;

  constructor(horloge: () => number = Date.now) {
    this.maintenant = horloge;
  }

  /**
   * Battement d'onde d'un agent (annonce initiale OU onde de vie).
   * Crée ou rafraîchit le nœud, recalcule son score, remet la sentinelle
   * à zéro. Retourne l'état interne du nœud.
   */
  battre(
    noeudId: string,
    userId: string,
    capacités: CapacitésNoeud,
  ): NoeudEssaim {
    const ts = this.maintenant();
    const existant = this.noeuds.get(noeudId);
    // Un nœud appartient à son utilisateur : un autre compte ne peut pas
    // détourner l'identité d'un nœud existant (sécurité de propriété).
    if (existant && existant.userId !== userId) {
      // Identité usurpée : on écrase proprement avec le nouveau propriétaire.
      this.noeuds.delete(noeudId);
    }
    const précédent = this.noeuds.get(noeudId);
    const succès = précédent?.succès ?? 0;
    const charge = précédent?.charge ?? 0;
    const noeud: NoeudEssaim = {
      noeudId,
      userId,
      capacités: {
        webgpu: capacités.webgpu === true,
        memoireGo: Number.isFinite(capacités.memoireGo) ? capacités.memoireGo : undefined,
        adaptateur: capacités.adaptateur?.slice(0, 80),
        features: Array.isArray(capacités.features)
          ? capacités.features.slice(0, 8).map(String)
          : undefined,
        appareil: capacités.appareil?.slice(0, 120),
      },
      score: scoreNoeud(
        { webgpu: capacités.webgpu === true, memoireGo: capacités.memoireGo, features: capacités.features },
        succès,
        ts,
        ts,
      ),
      charge,
      succès,
      ratés: 0,
      dernierBattement: ts,
      annoncéA: précédent?.annoncéA ?? ts,
    };
    if (this.noeuds.size >= BORNES_ESSAIM.noeudsMax && !précédent) {
      // Plafond honnête : on sacrifie le nœud le plus silencieux.
      const plusVieux = [...this.noeuds.values()].sort(
        (a, b) => a.dernierBattement - b.dernierBattement,
      )[0];
      if (plusVieux) this.noeuds.delete(plusVieux.noeudId);
    }
    this.noeuds.set(noeudId, noeud);
    return noeud;
  }

  /** Retourne le nœud si vivant (battement dans le TTL). */
  vivant(noeudId: string): NoeudEssaim | null {
    const n = this.noeuds.get(noeudId);
    if (!n) return null;
    if (this.maintenant() - n.dernierBattement > BORNES_ESSAIM.ttlNoeudMs) return null;
    return n;
  }

  /** Vrai si le nœud est enregistré (même silencieux). */
  connu(noeudId: string): boolean {
    return this.noeuds.has(noeudId);
  }

  /** Le nœud appartient-il bien à cet utilisateur ? */
  appartient(noeudId: string, userId: string): boolean {
    return this.noeuds.get(noeudId)?.userId === userId;
  }

  /** Incrémente la charge (fragment confié) — garde-fou anti-suralimentation. */
  charger(noeudId: string): boolean {
    const n = this.noeuds.get(noeudId);
    if (!n) return false;
    if (n.charge >= BORNES_ESSAIM.chargeMaxParNoeud) return false;
    n.charge += 1;
    return true;
  }

  /** Décharge (fragment rendu : terminé, échoué ou repris). */
  décharger(noeudId: string): void {
    const n = this.noeuds.get(noeudId);
    if (!n) return;
    n.charge = Math.max(0, n.charge - 1);
  }

  /** Crédite un succès (réputation → score futur). */
  créditerSuccès(noeudId: string): void {
    const n = this.noeuds.get(noeudId);
    if (!n) return;
    n.succès += 1;
  }

  /** Sortie d'un nœud (déconnexion propre annoncée par l'agent). */
  partir(noeudId: string): void {
    this.noeuds.delete(noeudId);
  }

  /**
   * SENTINELLE — détecte les déconnexions BRUSQUES : tout nœud dont le
   * dernier battement dépasse le TTL est déchargé de ses fragments en
   * cours (callback `surRupture`) puis retiré. Retourne les nœuds perdus.
   */
  balayageRuptures(surRupture: (noeud: NoeudEssaim) => void): NoeudEssaim[] {
    const ts = this.maintenant();
    const perdus: NoeudEssaim[] = [];
    for (const n of this.noeuds.values()) {
      if (ts - n.dernierBattement > BORNES_ESSAIM.ttlNoeudMs) {
        perdus.push(n);
      }
    }
    for (const n of perdus) {
      this.noeuds.delete(n.noeudId);
      surRupture(n);
    }
    return perdus;
  }

  /**
   * SÉLECTION DES 5 MEILLEURS APPAREILS — tri par score décroissant
   * (mémoire GPU d'abord), nœuds vivants uniquement, capés à équipeMax,
   * charge disponible exigée. Les nœuds de l'utilisateur demandeur ne
   * sont PAS exclus : son propre appareil participe à l'essaim.
   */
  sélectionnerÉquipe(exclusions: Set<string> = new Set()): NoeudEssaim[] {
    const ts = this.maintenant();
    return [...this.noeuds.values()]
      .filter((n) => !exclusions.has(n.noeudId))
      .filter((n) => ts - n.dernierBattement <= BORNES_ESSAIM.ttlNoeudMs)
      .filter((n) => n.capacités.webgpu)
      .filter((n) => n.charge < BORNES_ESSAIM.chargeMaxParNoeud)
      .sort((a, b) => b.score - a.score || a.charge - b.charge)
      .slice(0, BORNES_ESSAIM.équipeMax);
  }

  /** Liste des nœuds vivants d'un utilisateur (diagnostics + tests). */
  nœudsDe(userId: string): NoeudEssaim[] {
    const ts = this.maintenant();
    return [...this.noeuds.values()].filter(
      (n) => n.userId === userId && ts - n.dernierBattement <= BORNES_ESSAIM.ttlNoeudMs,
    );
  }

  /** État agrégé pour le panneau UI (jamais de données privées ici). */
  état(): ÉtatEssaim {
    const ts = this.maintenant();
    const vivants = [...this.noeuds.values()].filter(
      (n) => ts - n.dernierBattement <= BORNES_ESSAIM.ttlNoeudMs,
    );
    return {
      noeudsEnLigne: vivants.length,
      noeudsTotal: this.noeuds.size,
      top: vivants
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((n) => ({
          noeudId: n.noeudId.slice(0, 10),
          adaptateur: n.capacités.adaptateur ?? "adaptateur WebGPU",
          memoireGo: n.capacités.memoireGo ?? 0,
          score: n.score,
          charge: n.charge,
          succès: n.succès,
          âgeBattementMs: ts - n.dernierBattement,
        })),
    };
  }

  /** Vide le registre (tests). */
  réinitialiser(): void {
    this.noeuds.clear();
  }
}

/** Instance centrale (process unique PM2 — cf. en-tête). */
export const registreEssaim = new RegistreEssaim();
