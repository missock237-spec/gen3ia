import * as fs from "node:fs";

/**
 * AGENTS-OS — OBSERVATEUR DE FICHIERS DE LOGS (Module 1 : auto-guérison).
 *
 * Surveillance incrémentale de N fichiers par `fs.watchFile` (polling —
 * fiable sur NFS/Docker volumes où fs.watch rate) : seule la QUEUE du
 * fichier est relue depuis le dernier offset connu (coût O(nouvelles lignes),
 * jamais O(fichier)). La rotation/troncature est détectée par comparaison de
 * taille (offset > taille ⇒ re-scan depuis zéro) et par l'inode.
 *
 * Aucune dépendance externe : node:fs uniquement.
 */

/** Nombre de lignes relues au premier scan (queue du fichier — le passé
 *  ancien n'intéresse pas la guérison). */
const TAILLE_QUEUE_INITIALE = 500;

export interface LigneLog {
  /** Chemin de la source. */
  readonly fichier: string;
  /** Ligne brute (sans retour chariot final). */
  readonly ligne: string;
  /** Horodatage de la lecture (epoch ms). */
  readonly epochMs: number;
}

export interface SourceLog {
  /** Chemin absolu ou relatif du fichier de log. */
  readonly chemin: string;
  /** Période de polling en ms (défaut 2 000). */
  readonly intervalleMs?: number;
}

interface EtatSource {
  offset: number;
  inode: number | null;
  timer: NodeJS.Timeout | null;
}

/**
 * Observateur incrémental multi-sources. Usage :
 *
 *   const obs = new ObservateurLogs([{ chemin: "/var/log/app.log" }]);
 *   obs.demarrer((lignes) => analyseur.traiter(lignes));
 *   obs.arreter();
 */
export class ObservateurLogs {
  private readonly etats = new Map<string, EtatSource>();
  private actif = false;

  constructor(private readonly sources: readonly SourceLog[]) {
    for (const source of sources) {
      this.etats.set(source.chemin, { offset: 0, inode: null, timer: null });
    }
  }

  /**
   * Démarre le polling de toutes les sources. Le premier scan lit la QUEUE
   * de chaque fichier (bornée) pour ancrer l'offset sans inonder.
   */
  demarrer(surLignes: (lignes: readonly LigneLog[]) => void, surErreur?: (erreur: unknown, chemin: string) => void): void {
    if (this.actif) return;
    this.actif = true;
    for (const source of this.sources) {
      const intervalleMs = Math.max(500, source.intervalleMs ?? 2_000);
      const etat = this.etats.get(source.chemin)!;

      // Premier passage immédiat : ancre l'offset sur la queue du fichier.
      this.lireIncrement(source, etat, surLignes, surErreur, true);

      etat.timer = setInterval(() => {
        if (!this.actif) return;
        this.lireIncrement(source, etat, surLignes, surErreur, false);
      }, intervalleMs);
      // Ne pas empêcher la sortie du processus (daemon PM2 : PM2 gère).
      etat.timer.unref?.();
    }
  }

  /** Stoppe proprement tous les timers. */
  arreter(): void {
    this.actif = false;
    for (const etat of this.etats.values()) {
      if (etat.timer) {
        clearInterval(etat.timer);
        etat.timer = null;
      }
    }
  }

  /** Relit manuellement une source (tests, diagnostic). */
  lire(source: SourceLog, surLignes: (lignes: readonly LigneLog[]) => void, surErreur?: (erreur: unknown, chemin: string) => void): void {
    const etat = this.etats.get(source.chemin);
    if (!etat) throw new Error(`Source inconnue : ${source.chemin}`);
    this.lireIncrement(source, etat, surLignes, surErreur, false);
  }

  private lireIncrement(
    source: SourceLog,
    etat: EtatSource,
    surLignes: (lignes: readonly LigneLog[]) => void,
    surErreur: ((erreur: unknown, chemin: string) => void) | undefined,
    premierScan: boolean,
  ): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source.chemin);
    } catch (erreur) {
      // Fichier absent (rotation en cours, service pas encore démarré) :
      // ni crash ni bruit — un simple marquage suffit.
      surErreur?.(erreur, source.chemin);
      return;
    }

    const rotation = etat.inode !== null && (etat.inode !== stat.ino || etat.offset > stat.size);
    const depart = premierScan
      ? Math.max(0, stat.size - octetsDeQueue(TAILLE_QUEUE_INITIALE, source.chemin))
      : rotation
        ? 0
        : etat.offset;

    etat.inode = stat.ino;
    if (depart === 0 && stat.size === 0) {
      etat.offset = 0;
      return;
    }

    try {
      const descripteur = fs.openSync(source.chemin, "r");
      try {
        const longueur = stat.size - depart;
        if (longueur <= 0) {
          etat.offset = stat.size;
          return;
        }
        const tampon = Buffer.alloc(longueur);
        fs.readSync(descripteur, tampon, 0, longueur, depart);

        // Consommation EN OCTETS jusqu'au dernier \n (0x0A) inclus : exact
        // quel que soit l'encodage multi-octets, et la tranche finale sans
        // \n (ligne encore en écriture) reste en attente au prochain cycle.
        const dernierNL = tampon.lastIndexOf(0x0a);
        if (dernierNL < 0) {
          // Rien de complet dans cette tranche — offset inchangé.
          return;
        }
        const texte = tampon.subarray(0, dernierNL + 1).toString("utf8");

        const epochMs = Date.now();
        const produites = texte
          .split(/\r?\n/)
          .filter((l) => l.length > 0)
          .map((l) => ({ fichier: source.chemin, ligne: l, epochMs }));

        etat.offset = depart + dernierNL + 1;

        if (produites.length > 0) surLignes(produites);
      } finally {
        fs.closeSync(descripteur);
      }
    } catch (erreur) {
      surErreur?.(erreur, source.chemin);
    }
  }
}

/** Taille en octets des N dernières lignes approximée : on lit au plus
 *  64 Ko par ligne estimée, plafonné à la taille réelle. */
function octetsDeQueue(lignesEstimees: number, chemin: string): number {
  try {
    const taille = fs.statSync(chemin).size;
    return Math.min(taille, lignesEstimees * 64_000);
  } catch {
    return 0;
  }
}
