/**
 * LIVE STATE MANAGER — état temporaire (mission Phase 1) : présence par
 * participant et verrous de ressources en mémoire. La décision d'exécution
 * reste protégée par le verrou existant lib/live/decision-lock.ts (aucune
 * duplication). Redis est la cible mission ; tant qu'absent du projet,
 * ce gestionnaire mémoire joue ce rôle localement (documenté honnête).
 */

const globalState = globalThis as typeof globalThis & { __gen3iaLiveState?: EtatTemporaireLive };

interface EtatTemporaireLive {
  presence: Map<string, Set<string>>; // sessionId → participants présents
  verrous: Map<string, { detenteur: string; expireA: number }>; // clé → verrou TTL
}

function etat(): EtatTemporaireLive {
  if (!globalState.__gen3iaLiveState) {
    globalState.__gen3iaLiveState = { presence: new Map(), verrous: new Map() };
  }
  return globalState.__gen3iaLiveState;
}

/** Marque un participant présent (pouls) et retourne l'ensemble présent. */
export function marquerPresence(sessionId: string, participantId: string): string[] {
  const s = etat();
  let ensemble = s.presence.get(sessionId);
  if (!ensemble) {
    ensemble = new Set();
    s.presence.set(sessionId, ensemble);
  }
  ensemble.add(participantId);
  return [...ensemble];
}

/** Marque une déconnexion et retourne l'ensemble présent restant. */
export function marquerDeconnexion(sessionId: string, participantId: string): string[] {
  const s = etat();
  const ensemble = s.presence.get(sessionId);
  if (ensemble) {
    ensemble.delete(participantId);
    return [...ensemble];
  }
  return [];
}

/**
 * Verrou de ressource TTL (ex. « la caméra est ouverte par X »). Renvoie
 * false si détenu par un autre participant vivant — jamais de double usage.
 */
export function acquerirVerrou(sessionId: string, ressource: string, detenteur: string, ttlMs = 60_000): boolean {
  const s = etat();
  const cle = `${sessionId}:${ressource}`;
  const existant = s.verrous.get(cle);
  const t = Date.now();
  if (existant && existant.expireA > t && existant.detenteur !== detenteur) return false;
  s.verrous.set(cle, { detenteur, expireA: t + ttlMs });
  return true;
}

export function libererVerrou(sessionId: string, ressource: string, detenteur: string): void {
  const s = etat();
  const cle = `${sessionId}:${ressource}`;
  const v = s.verrous.get(cle);
  if (v && v.detenteur === detenteur) s.verrous.delete(cle);
}

export function etatPresence(sessionId: string): string[] {
  return [...(etat().presence.get(sessionId) ?? [])];
}

export function reinitialiserEtatLive(): void {
  delete globalState.__gen3iaLiveState;
}
