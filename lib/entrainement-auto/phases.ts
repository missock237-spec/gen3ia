import "server-only";

import type { BilanAutonomie, EtatAutoApprentissage, PhaseVie } from "./types";
import { dureeAbsorptionMs } from "./plafonds";

/**
 * LE CYCLE DE VIE DE L'IA — deux phases, une seule direction :
 *
 *   ABSORPTION (fenêtre bornée, défaut 2 h, depuis le PREMIER lancement)
 *     → Gen3ia se connecte à ses hubs (Hugging Face + Kaggle) et prend TOUT
 *       ce qu'elle peut de ses datasets, cycle après cycle rapproché ;
 *
 *   AUTONOMIE (clôture DÉFINITIVE, persistée — survit aux redémarrages)
 *     → les hubs ne sont plus JAMAIS interrogés ; l'IA s'appuie sur ce
 *       qu'elle a absorbé (bilan d'autonomie écrit une fois, honnête) et
 *       son évolution continue passe UNIQUEMENT par ses utilisateurs
 *       (consolidation des échanges réels — lib/neural/evolution.ts, déjà
 *       branchée sur chaque conversation du moteur neuronal).
 *
 * Ce module est PUR (aucun disque, aucun réseau) : la clôture renvoie un
 * nouvel état, la persistance reste à l'appelant (boucle.ts) — d'où des
 * tests déterministes et une machine à états impossible à corrompre par
 * un effet de bord I/O.
 */

/** Vue dérivée de la phase courante (calculée, jamais stockée en double). */
export interface VuePhase {
  phase: PhaseVie;
  /** La clôture est-elle déjà persistée dans l'état ? */
  absorptionCloturee: boolean;
  /** Date ISO de clôture (null tant que la fenêtre est ouverte). */
  clotureeA: string | null;
  /** Millisecondes restantes dans la fenêtre (0 si expirée, null en autonomie). */
  restantMs: number | null;
}

/**
 * Dérive la phase courante. La fenêtre court depuis `lanceA` (premier
 * lancement constaté — JAMAIS réinitialisé au reboot) + durée d'absorption ;
 * un reboot dans la fenêtre ne la repousse pas, un reboot après l'échéance
 * démarre directement en autonomie.
 */
export function phaseDe(
  etat: EtatAutoApprentissage,
  maintenantMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): VuePhase {
  if (etat.absorptionCloturee) {
    return { phase: "autonomie", absorptionCloturee: true, clotureeA: etat.absorptionClotureeA, restantMs: null };
  }
  const debut = Date.parse(etat.lanceA);
  const origine = Number.isFinite(debut) ? debut : maintenantMs;
  const restantMs = Math.max(0, origine + dureeAbsorptionMs(env) - maintenantMs);
  return { phase: "absorption", absorptionCloturee: false, clotureeA: null, restantMs };
}

/** La fenêtre est-elle expirée (clôture requise au prochain point de contrôle) ? */
export function absorptionExpiree(
  etat: EtatAutoApprentissage,
  maintenantMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const vue = phaseDe(etat, maintenantMs, env);
  return vue.phase === "absorption" && vue.restantMs === 0;
}

/**
 * BILAN D'AUTONOMIE — ce que l'IA sait de ce dont elle a besoin pour
 * évoluer. Déterministe et honnête : chaque axe est dérivé d'une métrique
 * réelle de l'état ; rien n'est inventé, rien n'est simulé. Les axes
 * nomment explicitement le nouveau canal d'évolution : les utilisateurs.
 */
export function bilanAutonomie(
  etat: EtatAutoApprentissage,
  maintenantMs: number = Date.now(),
): BilanAutonomie {
  const axes: string[] = [];

  if (etat.pairesCumulees === 0) {
    axes.push(
      "Langage : aucune paire conversationnelle absorbée — le cortex se renforcera par les échanges réels des utilisateurs.",
    );
  }
  if (etat.echantillonsCumules === 0) {
    axes.push(
      "Intentions : aucun échantillon étiqueté absorbé — la plasticité SNN se nourrira des corrections des utilisateurs.",
    );
  }
  const dernier = etat.dernierRapport;
  if (dernier?.intention && dernier.intention.accuracyTest < 0.75) {
    axes.push(
      `Précision d'intention mesurée à ${Math.round(dernier.intention.accuracyTest * 100)} % : consolider par les usages réels plutôt que par de nouvelles données hub.`,
    );
  }
  if (etat.datasetsIngestes.length === 0) {
    axes.push(
      "Socle : aucun dataset ingéré pendant la fenêtre — l'évolution repose sur le corpus Gen3 intégré et l'usage réel.",
    );
  }
  if (axes.length === 0) {
    axes.push(
      "Socle absorbé complet : l'évolution continue passe par les échanges des utilisateurs (consolidation automatique).",
    );
  }

  const debutAbsolu = Date.parse(etat.lanceA);
  const dureeUtiliseeMs = Math.max(
    0,
    Math.min(
      Number.isFinite(debutAbsolu) ? maintenantMs - debutAbsolu : 0,
      dureeAbsorptionMs(),
    ),
  );

  return {
    clotureA: new Date(maintenantMs).toISOString(),
    dureeUtiliseeMs,
    pairesAbsorbees: etat.pairesCumulees,
    echantillonsAbsorbes: etat.echantillonsCumules,
    datasetsAbsorbes: etat.datasetsIngestes.length,
    axes,
    message:
      `Absorption clôturée (${Math.round(dureeUtiliseeMs / 60_000)} min utilisées) — ` +
      `${etat.datasetsIngestes.length} dataset(s), ${etat.pairesCumulees} paire(s), ` +
      `${etat.echantillonsCumules} échantillon(s) absorbés. ` +
      `Gen3ia n'apprend plus de ses datasets : son évolution passe désormais par ses utilisateurs.`,
  };
}

/**
 * Clôture la fenêtre d'absorption — IDEMPOTENT et PUR : renvoie l'état
 * inchangé si la clôture était déjà faite, sinon le nouvel état clôturé
 * (bilan écrit UNE fois). L'appelant persiste (boucle.ts, écriture atomique).
 */
export function cloturerAbsorption(
  etat: EtatAutoApprentissage,
  maintenantMs: number = Date.now(),
): EtatAutoApprentissage {
  if (etat.absorptionCloturee) return etat;
  const bilan = bilanAutonomie(etat, maintenantMs);
  return {
    ...etat,
    absorptionCloturee: true,
    absorptionClotureeA: bilan.clotureA,
    bilanAutonomie: bilan,
  };
}
