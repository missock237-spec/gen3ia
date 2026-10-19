/**
 * Répartiteur local — la démonstration VIVANTE de l'essaim, dans le
 * navigateur. Chaque simulation demandée depuis /monde passe par ce
 * répartiteur : quotas (token bucket), sharding, équité mesurée. Les
 * chiffres affichés en bas de page sont les VRAIES métriques de VOTRE
 * session — la même classe `RepartiteurGlobal` que celle testée sous
 * 100 000 utilisateurs virtuels côté serveur.
 */

import { RepartiteurGlobal, type ConfigRepartiteur } from "@/lib/essaim-global/repartiteur";

/** Statistiques affichables de l'essaim local. */
export interface StatsEssaimLocal {
  servis: number;
  admises: number;
  refusees: number;
  equite: number;
  utilisateursSuivis: number;
  enAttente: number;
}

/** Configuration navigateur : files resserrées (mémoire onglet). */
const CONFIG_NAVIGATEUR: Partial<ConfigRepartiteur> = {
  fragments: 16,
  fileParFragment: 64,
  debitParUtilisateur: 10,
  rafale: 20,
  utilisateursSuivis: 5000,
};

let instance: RepartiteurGlobal | null = null;

/** Répartiteur de la session navigateur (singleton par onglet). */
export function repartiteurLocal(): RepartiteurGlobal {
  if (!instance) {
    instance = new RepartiteurGlobal(CONFIG_NAVIGATEUR);
  }
  return instance;
}

/** Enregistre une simulation servie (le navigateur EST le worker). */
export function servir(idSession: string): void {
  const r = repartiteurLocal();
  const decision = r.soumettre(`navigateur:${idSession.slice(0, 24)}`);
  if (decision.admis) {
    const ticket = r.prochain();
    if (ticket) r.terminer(ticket);
  }
}

/** Statistiques formatées pour l'affichage. */
export function statsLocales(): StatsEssaimLocal {
  const s = repartiteurLocal().stats();
  return {
    servis: s.admises,
    admises: s.admises,
    refusees: s.refuseesQuota + s.refuseesSature,
    equite: s.equite,
    utilisateursSuivis: s.utilisateursSuivis,
    enAttente: s.enAttente,
  };
}
