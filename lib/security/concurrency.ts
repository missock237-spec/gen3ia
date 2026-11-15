import "server-only";

/**
 * GARDE DE CONCURRENCE (durcissement production — « accueillir des
 * utilisateurs à grande échelle » sur un VPS 4 Go).
 *
 * Le rate limit (lib/security/rate-limit.ts) borne la FRÉQUENCE par
 * utilisateur/IP — il ne protège pas contre N utilisateurs LÉGITIMES qui
 * lancent en même temps des tours coûteux (LLM long, génération média,
 * orchestrations d'agents). En pic, chaque tour simultané retient :
 *   - une connexion serverless active (budget mémoire du process) ;
 *   - des appels LLM concurrents (latence P95 qui dérive pour TOUT LE
 *     MONDE dès que le tas V8 se sature).
 *
 * Cette garde est un SÉMAPHORE process-local : au-delà de MAX tours IA
 * simultanés, les nouveaux reçoivent IMMÉDIATEMENT un 429 honnête avec
 * Retry-After (jamais de file silencieuse qui dégrade tout le monde, jamais
 * de 502/OOM indigne). Le plafond est large (défaut 16) : un utilisateur
 * normal ne le verra JAMAIS — il ne se déclenche qu'en vraie saturation.
 *
 * Convention plateforme :
 *  - aucune fonction ne lève (dégradation gracieuse, comme lib/cache/redis) ;
 *  - configurable sans redéploiement via GEN3IA_MAX_CONCURRENT_TURNS
 *    (0/négatif ou valeur illisible → défaut) ;
 *  - exposition Prometheus (gen3ia_concurrency_*) pour la montée en charge
 *    observée — intégrée au registre /api/metrics.
 */

/** Plafond par défaut : 16 tours IA simultanés par process (VPS 4 Go, marge large). */
export const CONCURRENCE_DEFAUT = 16;

interface EtatConcurrence {
  actifs: number;
  totalAcquis: number;
  totalRefuses: number;
  /** Refus par route (cardinalité bornée : libellés fournis par les appelants). */
  refusesParRoute: Map<string, number>;
  maximum: number;
  creeLe: number;
}

const CLE_GLOBALE = "__gen3ia_concurrence_ia__";

function etat(): EtatConcurrence {
  const global = globalThis as unknown as Record<string, unknown>;
  const existant = global[CLE_GLOBALE] as EtatConcurrence | undefined;
  if (existant) return existant;
  const frais: EtatConcurrence = {
    actifs: 0,
    totalAcquis: 0,
    totalRefuses: 0,
    refusesParRoute: new Map(),
    maximum: lireMaximum(),
    creeLe: Date.now(),
  };
  global[CLE_GLOBALE] = frais;
  return frais;
}

/** Maximum effectif — relu À L'APPEL (un changement d'env s'applique sans redéploiement). */
function lireMaximum(): number {
  const brut = Number(process.env.GEN3IA_MAX_CONCURRENT_TURNS);
  if (!Number.isFinite(brut) || brut <= 0) return CONCURRENCE_DEFAUT;
  return Math.min(256, Math.floor(brut));
}

export interface JetonConcurrence {
  /** Libelle de la route (observabilité). */
  route: string;
  /** À APPELER ENFIN (try/finally) : libère le créneau. Idempotent. */
  release: () => void;
}

/**
 * Tente d'acquérir un créneau de tour IA. Retourne un jeton si la capacité
 * le permet, sinon null (l'appelant répond 429 + Retry-After).
 */
export function acquiertourIa(route: string): JetonConcurrence | null {
  const courant = etat();
  const maximum = lireMaximum();
  courant.maximum = maximum; // traçabilité du plafond observé
  if (courant.actifs >= maximum) {
    courant.totalRefuses += 1;
    courant.refusesParRoute.set(route, (courant.refusesParRoute.get(route) ?? 0) + 1);
    return null;
  }
  courant.actifs += 1;
  courant.totalAcquis += 1;
  let libere = false;
  return {
    route,
    release: () => {
      if (libere) return;
      libere = true;
      courant.actifs = Math.max(0, courant.actifs - 1);
    },
  };
}

/** Secondes conseillées avant nouvelle tentative (429 — Retry-After honnête). */
export const RETRY_AFTER_SECONDES = 5;

/** Instantané (tests, diagnostics, exposition Prometheus). */
export function instantaneConcurrence(): {
  actifs: number;
  maximum: number;
  totalAcquis: number;
  totalRefuses: number;
  refusesParRoute: Array<{ route: string; total: number }>;
} {
  const courant = etat();
  return {
    actifs: courant.actifs,
    maximum: courant.maximum,
    totalAcquis: courant.totalAcquis,
    totalRefuses: courant.totalRefuses,
    refusesParRoute: [...courant.refusesParRoute.entries()]
      .map(([route, total]) => ({ route, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10),
  };
}

/** Sérialisation Prometheus (intégrée à /api/metrics). */
export function concurrencePrometheus(): string {
  const s = instantaneConcurrence();
  const lignes: string[] = [
    "# HELP gen3ia_concurrency_active Tours IA actuellement simultanés dans ce process (garde de charge).",
    "# TYPE gen3ia_concurrency_active gauge",
    `gen3ia_concurrency_active ${s.actifs}`,
    "# HELP gen3ia_concurrency_max Plafond de tours IA simultanés (GEN3IA_MAX_CONCURRENT_TURNS, défaut 16).",
    "# TYPE gen3ia_concurrency_max gauge",
    `gen3ia_concurrency_max ${s.maximum}`,
    "# HELP gen3ia_concurrency_acquired_total Créneaux accordés depuis le démarrage du process.",
    "# TYPE gen3ia_concurrency_acquired_total counter",
    `gen3ia_concurrency_acquired_total ${s.totalAcquis}`,
    "# HELP gen3ia_concurrency_rejected_total Demandes refusées en saturation (429 honnête) par route.",
    "# TYPE gen3ia_concurrency_rejected_total counter",
  ];
  if (s.refusesParRoute.length === 0) {
    lignes.push(`gen3ia_concurrency_rejected_total{route="aucune"} 0`);
  } else {
    for (const serie of s.refusesParRoute) {
      lignes.push(`gen3ia_concurrency_rejected_total{route="${serie.route}"} ${serie.total}`);
    }
  }
  return `${lignes.join("\n")}\n`;
}
