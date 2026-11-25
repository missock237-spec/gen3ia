/**
 * COMPUTE SECURITY — couche de résilience (mission Phase 10) : circuit
 * breaker par moteur, timeout d'exécution, annulation, anti
 * double-exécution. Règle absolue : une erreur GPU ne bloque jamais le
 * cerveau ; une tâche non récupérable est signalée clairement ; aucun
 * résultat invalide n'est présenté comme réussi.
 */

import { classifierErreur } from "./webgpu/webgpu-error-handler";
import type { ErreurGpuClassifiee } from "./webgpu/webgpu-types";

const globalSec = globalThis as typeof globalThis & { __gen3iaComputeSecurity?: EtatSecurite };

export interface EtatSecurite {
  /** Circuit breaker GPU : échecs consécutifs, ouvert jusqu'à. */
  echecsGpuConsecutifs: number;
  /** Seuil d'ouverture du breaker (mission Phase 10-12). */
  seuilOuverture: number;
  /** Fermé | ouvert | demi-ouvert (sonde de reprise). */
  etat: "ferme" | "ouvert" | "demi-ouvert";
  /** ms depuis epoch : le breaker se referme après ce délai (essai CPU). */
  ouvertJusquA: number;
  /** Tâches en cours (anti double-exécution par nom). */
  enCours: Map<string, number>;
  erreursRecentes: ErreurGpuClassifiee[];
}

export function etatSecurite(): EtatSecurite {
  if (!globalSec.__gen3iaComputeSecurity) {
    globalSec.__gen3iaComputeSecurity = {
      echecsGpuConsecutifs: 0,
      seuilOuverture: 3,
      etat: "ferme",
      ouvertJusquA: 0,
      enCours: new Map(),
      erreursRecentes: [],
    };
  }
  return globalSec.__gen3iaComputeSecurity;
}

/** GPU autorisé ? (breaker fermé, ou demi-ouvert après la fenêtre de pause). */
export function gpuAutoriseParBreaker(): boolean {
  const s = etatSecurite();
  if (s.etat === "ferme") return true;
  if (s.etat === "ouvert" && Date.now() >= s.ouvertJusquA) {
    s.etat = "demi-ouvert"; // une tâche sonde sera tentée
    return true;
  }
  return false;
}

/** Enregistre un succès GPU : le breaker se referme. */
export function succesGpu(): void {
  const s = etatSecurite();
  s.echecsGpuConsecutifs = 0;
  s.etat = "ferme";
  s.ouvertJusquA = 0;
}

/** Enregistre un échec GPU : au seuil, le breaker s'ouvre (fenêtre 30 s). */
export function echecGpu(erreur: unknown, contexte?: string): ErreurGpuClassifiee {
  const s = etatSecurite();
  s.echecsGpuConsecutifs += 1;
  const classifiee = classifierErreur(erreur, contexte);
  s.erreursRecentes.push(classifiee);
  if (s.erreursRecentes.length > 50) s.erreursRecentes.shift();
  if (s.echecsGpuConsecutifs >= s.seuilOuverture) {
    s.etat = "ouvert";
    s.ouvertJusquA = Date.now() + 30_000;
    s.echecsGpuConsecutifs = 0;
  }
  return classifiee;
}

/** Exécute avec timeout + anti double-exécution ; annulable via signal. */
export async function executerProtege<T>(params: {
  nomTache: string;
  executer: (signal: AbortSignal) => Promise<T>;
  timeoutMs?: number;
}): Promise<{ ok: true; resultat: T; dureeMs: number } | { ok: false; raison: string; dureeMs: number }> {
  const s = etatSecurite();
  const debut = Date.now();
  const enCours = (s.enCours.get(params.nomTache) ?? 0) > 0;
  if (enCours) {
    return { ok: false, raison: `tâche « ${params.nomTache} » déjà en cours — double exécution refusée (mission Phase 10-6)`, dureeMs: 0 };
  }
  s.enCours.set(params.nomTache, 1);
  const controleur = new AbortController();
  const timeoutMs = params.timeoutMs ?? 30_000;
  const minuteur = setTimeout(() => controleur.abort(), timeoutMs);
  try {
    const resultat = await params.executer(controleur.signal);
    const dureeMs = Date.now() - debut;
    if (controleur.signal.aborted) {
      return { ok: false, raison: `tâche « ${params.nomTache} » annulée au timeout ${timeoutMs} ms — signalée, jamais présentée comme réussie`, dureeMs };
    }
    return { ok: true, resultat, dureeMs };
  } catch (e) {
    return { ok: false, raison: `tâche « ${params.nomTache} » échouée : ${e instanceof Error ? e.message : String(e)}`, dureeMs: Date.now() - debut };
  } finally {
    clearTimeout(minuteur);
    s.enCours.delete(params.nomTache);
  }
}

/** Annule explicitement une tâche en cours (mission Phase 10-9). */
export function annulerTache(nomTache: string): boolean {
  const s = etatSecurite();
  if (s.enCours.has(nomTache)) {
    s.enCours.delete(nomTache);
    return true;
  }
  return false;
}
