/**
 * AUTONOMY POLICY ENGINE (UCE V1.1 Phase 8) — l'autonomie est PROGRESSIVE et
 * CONTRÔLÉE (mission §Phase 8). Cinq niveaux :
 *
 *   1. OBSERVATION         — analyser, détecter ; AUCUNE modification ;
 *   2. RECHERCHE           — chercher des solutions, recommander ; AUCUNE
 *                            intégration ;
 *   3. EXPÉRIMENTATION     — installer/tester en SANDBOX isolée ; AUCUNE
 *                            modification de production ;
 *   4. INTÉGRATION CONTRÔLÉE — préparer et proposer une intégration ;
 *                            autorisation EXIGÉE pour les opérations
 *                            sensibles ;
 *   5. OPTIMISATION ENCADRÉE — déploiement automatique des modifications à
 *                            FAIBLE risque UNIQUEMENT si elles respectent
 *                            une politique préalablement approuvée, avec
 *                            tests, surveillance et rollback.
 *
 * RÈGLE ABSOLUE : le système ne peut JAMAIS modifier ses propres règles de
 * sécurité — le niveau n'est changé que par une commande admin portant un
 * identifiant humain (traçabilité), et les opérations « toujours soumises à
 * autorisation » (mission) ne sont JAMAIS automatiques, quel que soit le
 * niveau.
 */

import "server-only";

import { maintenantIso } from "../core/capability-contract";
import { sauvegarder, recuperer, lister, type RepositoryUceOptions } from "../storage/capability-repository";

export const NIVEAUX_AUTONOMIE = [1, 2, 3, 4, 5] as const;
export type NiveauAutonomie = (typeof NIVEAUX_AUTONOMIE)[number];

export const ACTIONS_CAPACITE = [
  "discover", "evaluate", "build", "improve", "disable", "replace", "monitor",
] as const;
export type ActionCapacite = (typeof ACTIONS_CAPACITE)[number];

/** Niveau minimal requis pour chaque action (défaut : le plus contraignant). */
const NIVEAU_MINIMAL_ACTION: Record<ActionCapacite, NiveauAutonomie> = {
  monitor: 1,
  evaluate: 1,
  discover: 2,
  build: 3,
  improve: 3,
  replace: 4,
  disable: 4,
};

/** Description honnête de chaque niveau (dashboard admin). */
export const DESCRIPTIONS_NIVEAUX: Record<NiveauAutonomie, string> = {
  1: "observation : analyse et détection uniquement, aucune modification",
  2: "recherche : solutions cherchées et recommandées, aucune intégration",
  3: "expérimentation : tests en sandbox isolée, aucune modification de production",
  4: "intégration contrôlée : intégrations préparées et proposées, autorisation exigée pour les opérations sensibles",
  5: "optimisation encadrée : déploiement automatique des modifications à faible risque uniquement (politique pré-approuvée, tests, surveillance, rollback)",
};

export interface VerdictAction {
  autorise: boolean;
  /** L'action est lancable mais exige une approbation humaine avant effet. */
  approbationRequise: boolean;
  niveau: NiveauAutonomie;
  raison: string;
}

export interface ContexteAction {
  action: ActionCapacite;
  /** Capacité cible (si l'action en vise une). */
  cible?: string;
  /** L'opération engage une dépense payante ? */
  coutPayant?: boolean;
  /** L'opération touche le cerveau central ? */
  toucheCerveau?: boolean;
  /** L'opération touche les politiques de sécurité ? */
  toucheSecurite?: boolean;
  /** L'opération utilise des secrets / comptes externes ? */
  secretOuCompteExterne?: boolean;
  /** Publication publique ou suppression de données ? */
  publicationOuSuppression?: boolean;
  /** Risque mesuré de la modification (niveau 5 uniquement). */
  risqueFaible?: boolean;
  /** Une politique préalablement approuvée couvre-t-elle cette action ? */
  politiqueApprouvee?: boolean;
}

export interface PolitiqueAutonomieEnregistree {
  id: string;
  niveau: NiveauAutonomie;
  /** Identifiant humain ayant posé le niveau (traçabilité obligatoire). */
  par: string;
  raison: string;
  majLe: string;
  schemaVersion: number;
}

const ID_POLITIQUE = "politique-autonomie" as const;

/** Lit le niveau persisté (défaut 1 — observation, le plus sûr). */
export async function niveauAutonomieActuel(options: RepositoryUceOptions = {}): Promise<{ niveau: NiveauAutonomie; par?: string; majLe?: string }> {
  const envBrut = process.env.AUTO_CAPABILITIES_LEVEL;
  const envNiveau = envBrut ? (Number.parseInt(envBrut, 10) as NiveauAutonomie) : undefined;
  const persistee = await recuperer<PolitiqueAutonomieEnregistree>("registry", ID_POLITIQUE, options);
  if (persistee && NIVEAUX_AUTONOMIE.includes(persistee.niveau)) {
    return { niveau: persistee.niveau, par: persistee.par, majLe: persistee.majLe };
  }
  return { niveau: envNiveau && NIVEAUX_AUTONOMIE.includes(envNiveau) ? envNiveau : 1 };
}

/**
 * Pose le niveau d'autonomie — UNIQUEMENT par identifiant humain (admin).
 * Aucun worker, aucune action automatique ne peut appeler cette fonction :
 * le système ne modifie jamais ses propres règles de sécurité.
 */
export async function definirNiveauAutonomie(
  niveau: NiveauAutonomie,
  params: { par: string; raison: string },
  options: RepositoryUceOptions = {},
): Promise<{ ok: boolean; raison: string }> {
  if (!NIVEAUX_AUTONOMIE.includes(niveau)) {
    return { ok: false, raison: `niveau invalide : ${String(niveau)} (autorisés : 1-5)` };
  }
  if (!params.par?.trim() || params.par.trim().length < 4) {
    return { ok: false, raison: "changement de niveau refusé : identifiant humain requis (le système ne modifie jamais ses propres règles)" };
  }
  if (!params.raison?.trim()) {
    return { ok: false, raison: "changement de niveau refusé : raison obligatoire (traçabilité)" };
  }
  const enregistrement: PolitiqueAutonomieEnregistree = {
    id: ID_POLITIQUE,
    niveau,
    par: params.par.slice(0, 120),
    raison: params.raison.slice(0, 300),
    majLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("registry", enregistrement, options);
  // Trace d'audit immuable (l'upsert « courante » n'écrase pas l'historique) :
  // chaque changement laisse un enregistrement daté unique.
  await sauvegarder("registry", { ...enregistrement, id: `${ID_POLITIQUE}-${Date.now().toString(36)}` }, options);
  return { ok: true, raison: `niveau d'autonomie posé à ${niveau} (${DESCRIPTIONS_NIVEAUX[niveau]}) par ${params.par}` };
}

/**
 * Évalue une action du cycle d'évolution contre la politique d'autonomie.
 * Réponse déterministe et traçable : autorisé / refusé / approbation
 * requise — aucune zone grise.
 */
export async function evaluerAction(contexte: ContexteAction, options: RepositoryUceOptions = {}): Promise<VerdictAction> {
  const { niveau } = await niveauAutonomieActuel(options);
  const action = contexte.action;

  // 1) Opérations TOUJOURS soumises à autorisation (mission Phase 8) —
  //    quel que soit le niveau, jamais automatiques.
  const toujoursGate =
    contexte.coutPayant ||
    contexte.toucheCerveau ||
    contexte.toucheSecurite ||
    contexte.secretOuCompteExterne ||
    contexte.publicationOuSuppression;
  if (toujoursGate) {
    return {
      autorise: true,
      approbationRequise: true,
      niveau,
      raison: `opération sensible (« ${action} ») : autorisation humaine TOUJOURS exigée (mission Phase 8), quel que soit le niveau ${niveau}`,
    };
  }

  // 2) Niveau minimal par action — en dessous : refus net.
  const niveauMin = NIVEAU_MINIMAL_ACTION[action];
  if (niveau < niveauMin) {
    return {
      autorise: false,
      approbationRequise: false,
      niveau,
      raison: `niveau d'autonomie ${niveau} insuffisant pour « ${action} » (minimum ${niveauMin} : ${DESCRIPTIONS_NIVEAUX[niveauMin]})`,
    };
  }

  // 3) Actions sensibles par nature — approbation toujours exigée.
  if (action === "disable" || action === "replace") {
    return {
      autorise: true,
      approbationRequise: true,
      niveau,
      raison: `« ${action} » touche une capacité en production : approbation humaine obligatoire`,
    };
  }

  // 4) Niveau 5 — déploiement automatique UNIQUEMENT à faible risque et
  //    couvert par une politique pré-approuvée ; sinon approbation.
  if (action === "build" || action === "improve") {
    if (niveau >= 5 && contexte.risqueFaible && contexte.politiqueApprouvee) {
      return {
        autorise: true,
        approbationRequise: false,
        niveau,
        raison: "niveau 5 : modification à faible risque couverte par une politique pré-approuvée (tests + surveillance + rollback exigés)",
      };
    }
    return {
      autorise: true,
      approbationRequise: true,
      niveau,
      raison: `« ${action} » exige une approbation avant intégration en production (niveau ${niveau} < 5 ou risque non faible / politique non pré-approuvée)`,
    };
  }

  // 5) Actions de lecture/propose — autorisées sans approbation.
  return {
    autorise: true,
    approbationRequise: false,
    niveau,
    raison: `« ${action} » autorisée au niveau ${niveau} (aucune modification de production)`,
  };
}

/** Historique des changements de niveau (audit complet, traces datées). */
export async function historiquePolitique(options: RepositoryUceOptions = {}, limite = 20): Promise<PolitiqueAutonomieEnregistree[]> {
  const traces = await lister<PolitiqueAutonomieEnregistree>("registry", {}, 200, options);
  return traces.filter((t) => t.id.startsWith(`${ID_POLITIQUE}-`)).slice(0, limite);
}
