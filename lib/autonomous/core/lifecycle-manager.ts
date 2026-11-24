/**
 * LIFECYCLE-MANAGER DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Persistance de l'état du core sur disque (`var/autonomous/etat.json`) —
 * même mécanique que `lib/neural/training/persistence.ts` : écriture
 * ATOMIQUE (tmp + rename) pour ne jamais laisser un état à moitié écrit,
 * lecture défensive (état corrompu → null, jamais de crash au boot).
 *
 * Contrainte du plan : « les opérations interrompues peuvent reprendre ».
 * Les tâches ouvertes (EN_ATTENTE / EN_COURS) sont persistées ; au
 * redémarrage, les EN_COURS retrouvées sont marquées REPRISE par le
 * task-manager puis ré-ouvertes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EtatPersisteCore } from "../core/types";

/** Version du schéma d'état (évolution sans cassure). */
export const VERSION_ETAT_CORE = 1;

/** Dossier d'état par défaut (cohérent avec var/neural/, var/entrainement-auto/). */
export function dossierEtatParDefaut(): string {
  return process.env.AUTO_CORE_DOSSIER?.trim() || join(process.cwd(), "var", "autonomous");
}

/** Chemin du fichier d'état. */
export function cheminEtat(dossier: string): string {
  return join(dossier, "etat.json");
}

/** Persiste l'état du core (atomique tmp+rename). Retourne le chemin ou null. */
export function persisterEtat(dossier: string, etat: EtatPersisteCore): string | null {
  try {
    mkdirSync(dossier, { recursive: true });
    const chemin = cheminEtat(dossier);
    const tmp = `${chemin}.tmp`;
    writeFileSync(tmp, JSON.stringify(etat, null, 1), "utf8");
    renameSync(tmp, chemin);
    return chemin;
  } catch {
    // Persistance impossible (disque) : le core continue en mémoire —
    // l'échec est visible via persisteLe absent du prochain instantané.
    return null;
  }
}

/** Charge l'état persisté (null si absent ou illisible — jamais de crash). */
export function chargerEtat(dossier: string): EtatPersisteCore | null {
  try {
    const brut = readFileSync(cheminEtat(dossier), "utf8");
    const etat = JSON.parse(brut) as EtatPersisteCore;
    if (etat?.version !== VERSION_ETAT_CORE || typeof etat.cycle !== "number") return null;
    if (!Array.isArray(etat.tachesOuvertes)) return null;
    return etat;
  } catch {
    return null;
  }
}
