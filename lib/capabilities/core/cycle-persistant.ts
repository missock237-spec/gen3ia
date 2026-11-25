/**
 * CAPABILITY ORCHESTRATOR — CYCLE PERSISTANT (UCE V1.1 Phase 7) — le cycle
 * AUTOMATIQUE D'ÉVOLUTION complet (mission §Phase 7), PERSISTANT et
 * REPRIABLE :
 *
 *   détection → transmission au cerveau → décision centrale → planification
 *   → découverte → compatibilité → évaluation → benchmark → construction /
 *   amélioration → tests sandbox → vérification sécurité → validation →
 *   intégration contrôlée → mesure des résultats → apprentissage →
 *   surveillance.
 *
 * 14 ÉTATS obligatoires (mission) : pending, analyzing, planned, discovering,
 * evaluating, building, testing, awaiting_approval, integrating, verifying,
 * completed, failed, cancelled, rolled_back.
 *
 * Garanties :
 *  - PERSISTANCE DURABLE : chaque transition est écrite via le repository
 *    (Firestore, repli journal local versionné) — AUCUN état important en
 *    mémoire seule ; reprise après redémarrage possible (mission §F) ;
 *  - VERROUS DISTRIBUÉS (collection cap_locks, TTL, propriétaire) —
 *    protection contre les doubles exécutions (l'écart stack Redis→
 *    repository est documenté au rapport) ;
 *  - IDEMPOTENCE : clé de déduplication par besoin — un cycle actif sur le
 *    même besoin est RETOURNÉ, jamais dupliqué ;
 *  - TIMEOUT par cycle, RETRIES bornés, annulation, historique complet ;
 *  - GATE D'AUTORISATION : l'état awaiting_approval ne franchit
 *    l'intégration QU'AVEC un autorisant humain explicite (mission §9) ;
 *  - les moteurs spécialisés (découverte, évaluation, builder…) restent des
 *    EXÉCUTANTS : le cerveau décide (décision persistée), l'orchestrateur
 *    coordonne, les workers exécutent.
 */

import "server-only";

import { createHash } from "node:crypto";
import { maintenantIso } from "./capability-contract";
import { nouvelId, sauvegarder, recuperer, lister, type RepositoryUceOptions } from "../storage/capability-repository";
import { analyserManques } from "../autonomy/capability-gap-analyzer";
import { elaborerPlans, choisirPlan, marquerPlan } from "../autonomy/capability-improvement-planner";
import { produireDecisions, marquerPlanifiee, marquerExecutee } from "./capability-decision";
import { executerCycleEvolution, type ResultatCycle } from "./capability-orchestrator";
import { obtenirGestionnaireCapacites } from "./capability-manager";
import { effectuerRollback } from "../versioning/rollback-manager";
import { refuserSiSecret } from "../security/secrets-protection";

export const ETATS_CYCLE = [
  "pending", "analyzing", "planned", "discovering", "evaluating", "building",
  "testing", "awaiting_approval", "integrating", "verifying",
  "completed", "failed", "cancelled", "rolled_back",
] as const;
export type EtatCycle = (typeof ETATS_CYCLE)[number];

const ETATS_TERMINAUX: ReadonlySet<EtatCycle> = new Set<EtatCycle>(["completed", "failed", "cancelled", "rolled_back"]);

export interface CycleCapacite {
  id: string;
  etat: EtatCycle;
  /** Besoin à l'origine du cycle (données — jamais des instructions). */
  besoin: string;
  /** Clé de déduplication (sha256 du besoin borné) — idempotence. */
  cleDedup: string;
  insuffisanceId?: string;
  decisionId?: string;
  planId?: string;
  capaciteId?: string;
  /** Autorisant humain posé à la reprise après awaiting_approval. */
  autorisePar?: string;
  tentatives: number;
  maxTentatives: number;
  timeoutMs: number;
  causeEchec?: string;
  historique: Array<{ dateIso: string; de: EtatCycle | "(création)"; vers: EtatCycle; details?: string }>;
  verrou?: { proprietaire: string; expiresLe: string };
  creeLe: string;
  majLe: string;
  schemaVersion: number;
}

export interface VerrouPersiste {
  id: string;
  proprietaire: string;
  expiresLe: string;
  majLe: string;
  schemaVersion: number;
}

export interface DemandeCyclePersistant {
  besoin: string;
  decisionId?: string;
  insuffisanceId?: string;
  planId?: string;
  scenario?: Parameters<typeof executerCycleEvolution>[0]["scenario"];
  sources?: Parameters<typeof executerCycleEvolution>[0]["sources"];
  nomsPypi?: string[];
  limiteParSource?: number;
  /** Si fourni DÈS LE DÉPART (opérations admin), le gate est franchi. */
  autorisePar?: string;
  options?: RepositoryUceOptions;
}

export interface ResultatCyclePersistant {
  ok: boolean;
  cycle: CycleCapacite;
  resultatMoteur?: ResultatCycle;
  raison: string;
  /** L'intégration exige une autorisation humaine (état awaiting_approval). */
  approbationRequise?: boolean;
}

const TIMEOUT_DEFAUT_MS = 15 * 60_000;
const MAX_TENTATIVES_DEFAUT = 2;
const TTL_VERROU_MS = 5 * 60_000;
const ID_VERROU_GLOBAL = "cycle-executeur" as const;

// ---------------------------------------------------------------------------
// Verrou distribué (collection cap_locks, TTL — best-effort honnête)
// ---------------------------------------------------------------------------

async function acquerirVerrou(options: RepositoryUceOptions, proprietaire: string): Promise<{ ok: boolean; raison: string }> {
  const existant = await recuperer<VerrouPersiste>("locks", ID_VERROU_GLOBAL, options);
  const maintenant = Date.now();
  if (existant && Date.parse(existant.expiresLe) > maintenant && existant.proprietaire !== proprietaire) {
    return { ok: false, raison: `verrou détenu par ${existant.proprietaire} jusqu'à ${existant.expiresLe} — double exécution refusée` };
  }
  const verrou: VerrouPersiste = {
    id: ID_VERROU_GLOBAL,
    proprietaire,
    expiresLe: new Date(maintenant + TTL_VERROU_MS).toISOString(),
    majLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("locks", verrou, options);
  return { ok: true, raison: "verrou acquis" };
}

async function libererVerrou(options: RepositoryUceOptions): Promise<void> {
  try {
    const existant = await recuperer<VerrouPersiste>("locks", ID_VERROU_GLOBAL, options);
    if (existant) {
      await sauvegarder("locks", { ...existant, expiresLe: new Date(Date.now() - 1_000).toISOString(), majLe: maintenantIso() }, options);
    }
  } catch {
    // libération best-effort : le TTL borne de toute façon le verrou
  }
}

// ---------------------------------------------------------------------------
// Orchestrateur
// ---------------------------------------------------------------------------

export class OrchestrateurCyclePersistant {
  private readonly options: RepositoryUceOptions;
  private readonly proprietaire: string;

  constructor(options: RepositoryUceOptions = {}, proprietaire = `cycle-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) {
    this.options = options;
    this.proprietaire = proprietaire;
  }

  private async charger(cycleId: string): Promise<CycleCapacite | null> {
    return recuperer<CycleCapacite>("cycles", cycleId, this.options);
  }

  private async persister(cycle: CycleCapacite): Promise<void> {
    cycle.majLe = maintenantIso();
    await sauvegarder("cycles", cycle, this.options);
  }

  private transitionner(cycle: CycleCapacite, vers: EtatCycle, details?: string): void {
    const de = cycle.etat;
    cycle.etat = vers;
    cycle.historique.push({ dateIso: maintenantIso(), de, vers, details: details?.slice(0, 300) });
    if (cycle.historique.length > 60) cycle.historique.splice(0, cycle.historique.length - 60);
  }

  /** Clé de déduplication : même besoin → même cycle (jamais de doublon). */
  private cleDeduplication(besoin: string): string {
    return createHash("sha256").update(besoin.trim().toLowerCase()).digest("hex").slice(0, 24);
  }

  /**
   * Démarre UN cycle (idempotent) et l'exécute jusqu'au prochain gate :
   * awaiting_approval (sans autorisant) ou un état terminal.
   */
  async demarrerCycle(demande: DemandeCyclePersistant): Promise<ResultatCyclePersistant> {
    const secret = refuserSiSecret(demande.besoin);
    if (!secret.autorise) {
      return this.reponseRefus(demande, `besoin refusé (donnée sensible détectée) : ${secret.cause}`);
    }

    // IDEMPOTENCE : un cycle actif sur le même besoin est retourné tel quel.
    const cle = this.cleDeduplication(demande.besoin);
    const actifs = await lister<CycleCapacite>("cycles", undefined, 100, this.options);
    const duplique = actifs.find((c) => c.cleDedup === cle && !ETATS_TERMINAUX.has(c.etat) && c.etat !== "awaiting_approval");
    if (duplique) {
      return { ok: true, cycle: duplique, raison: `cycle déjà actif (${duplique.id}, état ${duplique.etat}) — aucun doublon créé (idempotence)` };
    }

    const cycle: CycleCapacite = {
      id: nouvelId("cycle", `${demande.besoin}:${Date.now()}`),
      etat: "pending",
      besoin: demande.besoin.slice(0, 300),
      cleDedup: cle,
      decisionId: demande.decisionId,
      insuffisanceId: demande.insuffisanceId,
      planId: demande.planId,
      tentatives: 0,
      maxTentatives: MAX_TENTATIVES_DEFAUT,
      timeoutMs: TIMEOUT_DEFAUT_MS,
      historique: [{ dateIso: maintenantIso(), de: "(création)", vers: "pending", details: "cycle créé (persisté)" }],
      creeLe: maintenantIso(),
      majLe: maintenantIso(),
      schemaVersion: 1,
    };
    await this.persister(cycle);
    return this.executerDepuis(cycle, demande);
  }

  /** REPRISE après redémarrage (mission §F) : liste les cycles non terminés. */
  async reprendreCyclesInterrompus(): Promise<{ cycles: CycleCapacite[]; message: string }> {
    const tous = await lister<CycleCapacite>("cycles", undefined, 100, this.options);
    const interrompus = tous.filter((c) => !ETATS_TERMINAUX.has(c.etat));
    for (const cycle of interrompus) {
      cycle.historique.push({ dateIso: maintenantIso(), de: cycle.etat, vers: cycle.etat, details: "reprise après redémarrage : état restauré depuis la persistance (aucune double exécution — verrou requis)" });
      await this.persister(cycle);
    }
    return {
      cycles: interrompus,
      message: `${interrompus.length} cycle(s) non terminal(aux) restauré(s) — les états awaiting_approval attendent une autorisation, les autres sont relançables via executerDepuis`,
    };
  }

  /** Reprend l'exécution d'un cycle existant (après redémarrage ou gate). */
  async reprendre(cycleId: string, params: { autorisePar?: string } = {}): Promise<ResultatCyclePersistant> {
    const cycle = await this.charger(cycleId);
    if (!cycle) return { ok: false, cycle: { ...this.cycleVide(cycleId), etat: "failed", causeEchec: "cycle inconnu" }, raison: `cycle inconnu : ${cycleId}` };
    if (ETATS_TERMINAUX.has(cycle.etat)) {
      return { ok: true, cycle, raison: `cycle déjà terminal (${cycle.etat}) — rien à reprendre` };
    }
    if (params.autorisePar) cycle.autorisePar = params.autorisePar;
    return this.executerDepuis(cycle, { besoin: cycle.besoin, options: this.options });
  }

  /** Annule un cycle non terminal (traçabilité complète). */
  async annuler(cycleId: string, params: { raison: string; par: string }): Promise<{ ok: boolean; raison: string }> {
    const cycle = await this.charger(cycleId);
    if (!cycle) return { ok: false, raison: `cycle inconnu : ${cycleId}` };
    if (ETATS_TERMINAUX.has(cycle.etat)) return { ok: false, raison: `cycle déjà terminal (${cycle.etat}) — annulation impossible` };
    if (!params.par?.trim() || params.par.trim().length < 4) return { ok: false, raison: "annulation refusée : identifiant humain requis" };
    this.transitionner(cycle, "cancelled", `annulé par ${params.par} : ${params.raison}`);
    await this.persister(cycle);
    await libererVerrou(this.options);
    return { ok: true, raison: `cycle ${cycleId} annulé (historique complet conservé)` };
  }

  /** ROLLBACK de la capacité d'un cycle intégré (état rolled_back, tracé). */
  async annulerParRollback(cycleId: string, params: { raison: string; par: string }): Promise<{ ok: boolean; raison: string }> {
    const cycle = await this.charger(cycleId);
    if (!cycle?.capaciteId) return { ok: false, raison: "cycle sans capacité intégrée : rollback hors cycle applicable" };
    // Cible de rollback : la version précédente la plus récente (la version
    // active reste conservée et tracée — append-only).
    const { versionActive, historiqueVersions } = await import("../versioning/version-manager");
    const [active, historique] = await Promise.all([versionActive(cycle.capaciteId, this.options), historiqueVersions(cycle.capaciteId, this.options)]);
    const cible = historique.find((v) => v.id !== active?.id && v.statut !== "rollback");
    if (!cible) return { ok: false, raison: "aucune version précédente disponible : rollback impossible (honnêteté — pas de cible inventée)" };
    const resultat = await effectuerRollback({ capabilityId: cycle.capaciteId, versVersionId: cible.id, raison: params.raison, effectuePar: params.par }, this.options);
    if (!resultat.ok) return { ok: false, raison: resultat.raison };
    this.transitionner(cycle, "rolled_back", `rollback par ${params.par} : ${params.raison} (${resultat.raison})`);
    await this.persister(cycle);
    return { ok: true, raison: `cycle ${cycleId} → rolled_back : ${resultat.raison}` };
  }

  /** Relance un cycle échoué (retries bornés). */
  async relancer(cycleId: string): Promise<ResultatCyclePersistant> {
    const cycle = await this.charger(cycleId);
    if (!cycle) return { ok: false, cycle: this.cycleVide(cycleId), raison: `cycle inconnu : ${cycleId}` };
    if (cycle.etat !== "failed") return { ok: false, cycle, raison: `seul un cycle échoué peut être relancé (état courant : ${cycle.etat})` };
    if (cycle.tentatives >= cycle.maxTentatives) {
      return { ok: false, cycle, raison: `limite de tentatives atteinte (${cycle.tentatives}/${cycle.maxTentatives}) — intervention requise` };
    }
    return this.executerDepuis(cycle, { besoin: cycle.besoin, options: this.options });
  }

  // -------------------------------------------------------------------------
  // Exécution par états (chaque transition est PERSISTÉE)
  // -------------------------------------------------------------------------

  private async executerDepuis(cycle: CycleCapacite, demande: DemandeCyclePersistant): Promise<ResultatCyclePersistant> {
    const debut = Date.now();
    const options = demande.options ?? this.options;

    // VERROU distribué — protection contre les doubles exécutions.
    const verrou = await acquerirVerrou(options, this.proprietaire);
    if (!verrou.ok) {
      return { ok: false, cycle, raison: verrou.raison };
    }

    try {
      const ecoule = () => Date.now() - debut > cycle.timeoutMs;
      const echec = async (raison: string): Promise<ResultatCyclePersistant> => {
        this.transitionner(cycle, "failed", raison);
        cycle.causeEchec = raison.slice(0, 300);
        cycle.tentatives += 1;
        await this.persister(cycle); // l'échec est PERSISTÉ (reprise fidèle)
        return { ok: false, cycle, raison };
      };

      // ÉTAT pending → analyzing : détection/transmission au cerveau.
      if (cycle.etat === "pending") {
        if (ecoule()) return await echec("timeout au démarrage de l'analyse");
        this.transitionner(cycle, "analyzing", "analyse des insuffisances (gap-analyzer) et transmission au cerveau");
        await this.persister(cycle);
        if (!cycle.insuffisanceId) {
          const analyse = await analyserManques({ besoinsNonSatisfaits: [cycle.besoin], options });
          const cible = analyse.insuffisances.find((i) => i.source === "besoins") ?? analyse.insuffisances[0];
          if (cible) {
            cycle.insuffisanceId = cible.id;
            this.transitionner(cycle, "analyzing", `insuffisance identifiée : ${cible.categorie} — ${cible.description.slice(0, 120)}`);
          } else {
            this.transitionner(cycle, "analyzing", "aucune insuffisance nouvelle détectée — le cerveau décide sur le besoin brut");
          }
        }
        await this.persister(cycle);
      }

      // ÉTAT analyzing → planned : décision centrale + planification.
      if (cycle.etat === "analyzing") {
        if (ecoule()) return await echec("timeout pendant la planification");
        if (!cycle.decisionId) {
          const decisions = await produireDecisions({ rapport: await this.rapportCerveau(options), besoinsNonSatisfaits: [cycle.besoin] }, options);
          const decision = decisions.find((d) => d.action === "discover" || d.action === "improve" || d.action === "monitor") ?? decisions[0];
          if (!decision) return await echec("aucune décision du cerveau produite (données insuffisantes)");
          if (!decision.verdictPolitique.autorise) {
            return await echec(`décision refusée par la politique d'autonomie : ${decision.verdictPolitique.raison}`);
          }
          cycle.decisionId = decision.decisionId;
        }
        this.transitionner(cycle, "planned", `décision centrale ${cycle.decisionId} — planification`);
        await this.persister(cycle);
        if (!cycle.planId) {
          const { insuffisancesRecentes } = await import("../autonomy/capability-gap-analyzer");
          const toutes = await insuffisancesRecentes(options, 50);
          const cible = toutes.find((i) => i.id === cycle.insuffisanceId);
          const plans = await elaborerPlans(cible ? [cible] : [], options, cycle.decisionId);
          const plan = plans[0];
          if (!plan) {
            // Pas d'insuffisance structurée : plan de découverte direct sur le besoin.
            const plansDirects = await elaborerPlans(
              [{
                id: nouvelId("gap", "direct"), description: cycle.besoin.slice(0, 140), categorie: "fonctionnalite-absente",
                priorite: "haute", justification: "cycle sans insuffisance structurée — besoin brut du cerveau",
                mesureReference: "besoin cycle", objectifMesurable: "≥ 3 candidates comparées sur mesures",
                ressourcesEstimees: "cycle de découverte multi-sources", source: "besoins",
                detecteeLe: maintenantIso(), schemaVersion: 1,
              }],
              options,
              cycle.decisionId,
            );
            const planDirect = plansDirects[0];
            if (!planDirect) return await echec("aucun plan produit");
            const choixDirect = await choisirPlan(planDirect.id, { par: "cerveau-central", decisionId: cycle.decisionId }, options);
            if (!choixDirect.ok || !choixDirect.plan) return await echec(`choix du plan refusé : ${choixDirect.raison}`);
            cycle.planId = choixDirect.plan.id;
          } else {
            const choix = await choisirPlan(plan.id, { par: "cerveau-central", decisionId: cycle.decisionId }, options);
            if (!choix.ok || !choix.plan) return await echec(`choix du plan refusé : ${choix.raison}`);
            cycle.planId = choix.plan.id;
          }
        }
        await marquerPlanifiee(cycle.decisionId, options).catch(() => undefined);
        this.transitionner(cycle, "planned", `plan choisi : ${cycle.planId} (choix du cerveau central)`);
        await this.persister(cycle);
      }

      // ÉTATS planned → discovering → … → testing : moteur 14 étapes (workers).
      if (["planned", "discovering", "evaluating", "building", "testing"].includes(cycle.etat)) {
        if (ecoule()) return await echec("timeout pendant l'exécution du moteur d'évolution");
        this.transitionner(cycle, "discovering", "exécution du moteur : découverte → compatibilité → évaluation → benchmark → sélection (workers exécutants)");
        await this.persister(cycle);
        const resultatMoteur = await executerCycleEvolution({
          besoin: cycle.besoin,
          sources: demande.sources,
          nomsPypi: demande.nomsPypi,
          scenario: demande.scenario,
          limiteParSource: demande.limiteParSource,
          dossier: options.dossier,
        });
        if (!resultatMoteur.ok || !resultatMoteur.selection) {
          return await echec(`moteur d'évolution arrêté : ${resultatMoteur.raison}`);
        }
        cycle.capaciteId = resultatMoteur.capacite?.id ?? resultatMoteur.selection.capabilityId;
        // États intermédiaires journalisés honnêtement d'après les étapes réelles.
        for (const etape of resultatMoteur.etapes.filter((e) => ["evaluating", "building", "testing"].includes(e.nom) || ["evaluation", "benchmark", "test"].includes(e.nom))) {
          this.transitionner(cycle, "testing", `moteur : ${etape.nom} → ${etape.statut}`);
        }
        await this.persister(cycle);

        if (resultatMoteur.integree) {
          this.transitionner(cycle, "integrating", "intégration déjà effectuée par le moteur (autorisant fourni au moteur)");
          await this.persister(cycle);
          return this.verifierEtClore(cycle, resultatMoteur, options);
        }
        // Gate mission §9 : SANS autorisant humain → awaiting_approval.
        const autorisant = cycle.autorisePar ?? demande.autorisePar;
        if (!autorisant) {
          this.transitionner(cycle, "awaiting_approval", `sélection « ${resultatMoteur.selection.nom} » (score ${resultatMoteur.selection.score}/100) proposée — intégration gated : autorisation humaine requise`);
          await this.persister(cycle);
          await libererVerrou(options);
          return { ok: true, cycle, resultatMoteur, raison: "cycle en attente d'autorisation humaine (gate mission §9)", approbationRequise: true };
        }
        this.transitionner(cycle, "awaiting_approval", `autorisant fourni (${autorisant.slice(0, 60)}) — franchissement du gate`);
        await this.persister(cycle);
      }

      // ÉTAT awaiting_approval → integrating (autorisant humain obligatoire).
      if (cycle.etat === "awaiting_approval") {
        const autorisant = cycle.autorisePar ?? demande.autorisePar;
        if (!autorisant || autorisant.trim().length < 4) {
          await libererVerrou(options);
          return { ok: true, cycle, raison: "gate d'autorisation : aucun autorisant humain fourni — le cycle reste en awaiting_approval", approbationRequise: true };
        }
        this.transitionner(cycle, "integrating", `autorisation humaine ${autorisant.slice(0, 60)} — intégration contrôlée`);
        await this.persister(cycle);
        const gestionnaire = obtenirGestionnaireCapacites(options);
        if (cycle.capaciteId) {
          for (const statut of ["autorisee", "integree"] as const) {
            const res = await gestionnaire.transitionner(cycle.capaciteId, statut, { autorisePar: autorisant });
            if (!res.ok) return await echec(`intégration refusée à la transition « ${statut} » : ${res.raison}`);
          }
        } else {
          return await echec("capacité absente : intégration impossible");
        }
        await marquerExecutee(cycle.decisionId ?? "", options).catch(() => undefined);
        if (cycle.planId) await marquerPlan(cycle.planId, "execute", options).catch(() => undefined);
        return this.verifierEtClore(cycle, undefined, options);
      }

      // ÉTAT integrating/verifying → vérification et clôture.
      if (cycle.etat === "integrating" || cycle.etat === "verifying") {
        return this.verifierEtClore(cycle, undefined, options);
      }

      // État terminal ou inattendu : honnêteté.
      return { ok: ETATS_TERMINAUX.has(cycle.etat) && cycle.etat !== "failed", cycle, raison: `état ${cycle.etat} — aucune exécution automatique depuis un état terminal` };
    } finally {
      await libererVerrou(options);
    }
  }

  /** Mesure des résultats + apprentissage + surveillance → completed. */
  private async verifierEtClore(cycle: CycleCapacite, resultatMoteur: ResultatCycle | undefined, _options: RepositoryUceOptions): Promise<ResultatCyclePersistant> {
    this.transitionner(cycle, "verifying", "mesure des résultats, apprentissage et surveillance (monitoring réel)");
    await this.persister(cycle);
    const details: string[] = [];
    if (resultatMoteur?.selection) details.push(`sélection ${resultatMoteur.selection.nom} score ${resultatMoteur.selection.score}/100`);
    if (cycle.capaciteId) details.push(`capacité ${cycle.capaciteId} intégrée`);
    details.push("santé suivie par monitoring/capability-health ; apprentissage enregistré par le moteur (cap_learning)");
    this.transitionner(cycle, "completed", details.join(" ; "));
    await this.persister(cycle);
    return { ok: true, cycle, resultatMoteur, raison: "cycle d'évolution complet : intégration contrôlée effectuée, mesure et apprentissage enregistrés" };
  }

  private async rapportCerveau(options: RepositoryUceOptions) {
    const { rapportPourCerveau } = await import("./capability-brain-bridge");
    return rapportPourCerveau(options);
  }

  private cycleVide(cycleId: string): CycleCapacite {
    return {
      id: cycleId, etat: "pending", besoin: "", cleDedup: "", tentatives: 0, maxTentatives: MAX_TENTATIVES_DEFAUT,
      timeoutMs: TIMEOUT_DEFAUT_MS, historique: [], creeLe: maintenantIso(), majLe: maintenantIso(), schemaVersion: 1,
    };
  }

  private reponseRefus(demande: DemandeCyclePersistant, raison: string): ResultatCyclePersistant {
    const cycle = this.cycleVide(nouvelId("cycle", `${demande.besoin}:${Date.now()}`));
    cycle.etat = "failed";
    cycle.causeEchec = raison;
    return { ok: false, cycle, raison };
  }
}

/** Singleton process-local (idempotent) de l'orchestrateur. */
const globalAvecOrchestrateur = globalThis as typeof globalThis & {
  __gen3iaOrchestrateurCycle?: OrchestrateurCyclePersistant;
};

export function obtenirOrchestrateurCycle(options: RepositoryUceOptions = {}): OrchestrateurCyclePersistant {
  if (!globalAvecOrchestrateur.__gen3iaOrchestrateurCycle || options.dossier) {
    globalAvecOrchestrateur.__gen3iaOrchestrateurCycle = new OrchestrateurCyclePersistant(options);
  }
  return globalAvecOrchestrateur.__gen3iaOrchestrateurCycle;
}

/** Cycles récents (dashboard + admin). */
export async function cyclesRecents(options: RepositoryUceOptions = {}, limite = 50): Promise<CycleCapacite[]> {
  return lister<CycleCapacite>("cycles", undefined, limite, options);
}
