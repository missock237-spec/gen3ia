/**
 * L'Orchestrateur d'Agents — le système nerveux central de l'essaim.
 *
 * RÈGLE ABSOLUE (demande produit) : TOUS les agents sont connectés à
 * l'IA principale Gen3. Concrètement :
 *
 *  · aucun agent ne « parle » librement aux autres agents ;
 *  · chaque tâche est OUVERTE par le cortex (l'IA principale) ou par
 *    l'utilisateur agissant sous la parole du cortex ;
 *  · chaque résultat, local ou reçu par onde P2P, remonte AUSSI au
 *    cortex (`IAprincipale.recevoirCompteRendu`) — qui journalise,
 *    réfléchit, et peut commander des tâches de suivi.
 *
 * Distribution : une tâche est diffusée en onde aux pairs (WebRTC) ;
 * chaque nœud disposant de la spécialité et de la capacité la réclame
 * (premier arrivé, premier servi) et renvoie le résultat EN DIRECT au
 * cortex émetteur. En l'absence de pairs, l'agent local exécute —
 * l'essaim fonctionne à un nœud comme à mille.
 */

import type { AgentExecutant } from "./agents-specialises";
import type {
  ChargeAnnonce,
  ChargeBattement,
  ChargeResultat,
  ChargeSos,
  MessageAgent,
  MicroAgent,
  PrioriteTache,
  TacheAgent,
  TypeAgent,
} from "./types";
import { BORNES_AGENTS } from "./types";
import type { NoeudAgents } from "./noeud-agents";

/* ------------------------------------------------------------------ */
/* L'IA principale — le cortex Gen3 auquel tout remonte                */
/* ------------------------------------------------------------------ */

/** Contrat de l'IA principale : tout agent lui est connecté. */
export interface IAprincipale {
  /** Reçoit le compte-rendu normalisé d'une tâche terminée. */
  recevoirCompteRendu(tache: TacheAgent): void;
}

/** Décision du cortex : une tâche de suivi qu'il ordonne. */
export interface DecisionCortex {
  ts: number;
  motif: string;
  tache: TacheAgent;
}

/**
 * CortexGen3Local — implémentation locale de l'IA principale.
 * Déterministe et instantanée : elle agrège les comptes-rendus,
 * maintient la vue d'ensemble de l'essaim et applique des règles de
 * suivi (rupture détectée → tri des signaux modifiés ; motif risqué
 * dans du code → mise en garde consignée…). Dans la plateforme, la
 * même interface est réalisée par le chat IA (dashboard) : les agents
 * restent sous commande de l'IA, jamais l'inverse.
 */
export class CortexGen3Local implements IAprincipale {
  private rapports: TacheAgent[] = [];
  private decisions: DecisionCortex[] = [];
  private commander: ((tache: TacheAgent) => void) | null = null;

  /** Rattache le cortex à la fonction qui ouvre réellement une tâche. */
  rattacher(commander: (tache: TacheAgent) => void): void {
    this.commander = commander;
  }

  recevoirCompteRendu(tache: TacheAgent): void {
    this.rapports.push(tache);
    if (this.rapports.length > 256) this.rapports = this.rapports.slice(-128);
    this.reflechir(tache);
  }

  /** Règles de suivi du cortex — chaque décision est consignée. */
  private reflechir(tache: TacheAgent): void {
    const r = tache.resultat;
    if (!r) return;

    if (tache.type === "veille") {
      const modifies = (r.donnees?.modifies as string[] | undefined) ?? [];
      if (modifies.length > 0) {
        this.ordonner(
          `Rupture de signal détectée (${modifies.length} modification(s)) — j'ordonne un tri des signaux modifiés.`,
          {
            id: `t-suivi-${tache.id}`,
            type: "tri",
            charge: { elements: modifies.slice(0, 32), criteres: ["modifie", "alerte", "nouveau"] },
            priorite: "haute",
            emiseA: Date.now(),
            emetteur: tache.emetteur,
            statut: "en-attente",
            delaiMs: BORNES_AGENTS.delaiOrphelin,
          },
        );
      }
      return;
    }

    if (tache.type === "code" && Array.isArray(r.donnees?.risques) && (r.donnees.risques as string[]).length > 0) {
      this.decisions.push({
        ts: Date.now(),
        motif: `Code risqué signalé (${(r.donnees.risques as string[]).join(", ")}) — mise en garde consignée, aucune exécution automatique.`,
        tache,
      });
      return;
    }

    if (r.confiance < 0.5) {
      this.decisions.push({
        ts: Date.now(),
        motif: `Résultat incertain de l'agent « ${tache.type} » (confiance ${r.confiance.toFixed(2)}) — je garde la main, pas de suivi automatique.`,
        tache,
      });
    }
  }

  private ordonner(motif: string, tache: TacheAgent): void {
    this.decisions.push({ ts: Date.now(), motif, tache });
    if (this.decisions.length > 128) this.decisions = this.decisions.slice(-64);
    this.commander?.(tache);
  }

  /** Vue d'ensemble synthétique (affichée dans la console). */
  etat(): { nbRapports: number; confianceMoyenne: number; dernierResume: string; decisions: DecisionCortex[] } {
    const confiances = this.rapports.map((t) => t.resultat?.confiance ?? 0);
    const moyenne = confiances.length ? confiances.reduce((a, b) => a + b, 0) / confiances.length : 0;
    return {
      nbRapports: this.rapports.length,
      confianceMoyenne: moyenne,
      dernierResume: this.rapports[this.rapports.length - 1]?.resultat?.resume ?? "Aucun compte-rendu reçu.",
      decisions: [...this.decisions].slice(-12),
    };
  }
}

/* ------------------------------------------------------------------ */
/* L'orchestrateur — distribution des tâches + connexion au cortex     */
/* ------------------------------------------------------------------ */

export interface OptionsOrchestrateur {
  idNoeud: string;
  /** Nœud P2P (absent : mode local pur — l'orchestrateur reste complet). */
  noeud?: NoeudAgents;
  /** L'IA principale à laquelle TOUS les agents sont connectés. */
  ia: IAprincipale;
  surEvenement?: (evenement: { type: string; detail: string }) => void;
}

interface NoeudDistant {
  id: string;
  nom: string;
  specialites: TypeAgent[];
  capacite: number;
  amplitude: number;
  dernierBattement: number;
}

const PRIORITES: Record<PrioriteTache, number> = {
  critique: 0,
  haute: 1,
  normale: 2,
  basse: 3,
};

export class OrchestrateurAgents {
  readonly idNoeud: string;
  private readonly noeud: NoeudAgents | undefined;
  private readonly ia: IAprincipale;
  private readonly surEvenement: ((e: { type: string; detail: string }) => void) | undefined;

  /** Agents locaux par spécialité (ce nœud offre ces capacités). */
  private agentsLocaux = new Map<TypeAgent, AgentExecutant>();
  private microAgents = new Map<TypeAgent, MicroAgent>();

  /** Tâches ouvertes ici (cortex local) — en attente de résultat. */
  private tachesOuvres = new Map<string, TacheAgent>();
  /** Tâches déjà conclues (déduplication premier-arrivé-gagne). */
  private tachesResolues = new Set<string>();
  /** Tâches reçues par onde déjà traitées (déduplication cascade). */
  private tachesRecues = new Set<string>();
  /** File locale priorisée (exécution locale). */
  private fileLocale: TacheAgent[] = [];
  /** Nœuds distants connus, tenus par les battements d'ondes. */
  private noeudsDistants = new Map<string, NoeudDistant>();

  private minuteries: ReturnType<typeof setInterval>[] = [];
  private stats = {
    tachesOuvres: 0,
    tachesExecutees: 0,
    resultatsRecus: 0,
    comptesRendus: 0,
    rechutes: 0,
  };

  constructor(options: OptionsOrchestrateur) {
    this.idNoeud = options.idNoeud;
    this.noeud = options.noeud;
    this.ia = options.ia;
    this.surEvenement = options.surEvenement;
  }

  /* ---------------------------- cycle de vie ---------------------- */

  demarrer(): void {
    if (this.minuteries.length > 0) return;
    // Onde de vie : amplitude = santé du nœud (résilience par résonance).
    this.minuteries.push(
      setInterval(() => this.battre(), BORNES_AGENTS.periodeBattement),
    );
    // Balayage des ondes orphelines (détection de rupture de phase).
    this.minuteries.push(setInterval(() => this.balayer(), 2000));
    this.noeud?.demarrer();
  }

  arreter(): void {
    for (const t of this.minuteries) clearInterval(t);
    this.minuteries = [];
    this.noeud?.arreter();
  }

  /* ---------------------------- agents ---------------------------- */

  /** Enregistre un agent local : ce nœud offre désormais sa spécialité. */
  enregistrerAgent(agent: AgentExecutant): void {
    this.agentsLocaux.set(agent.type, agent);
    this.microAgents.set(agent.type, {
      id: `${this.idNoeud}:${agent.type}`,
      nom: agent.nom,
      type: agent.type,
      description: agent.description,
      etat: "veille",
      tachesTraitees: 0,
      tachesEchouees: 0,
      charge: 0,
      dernierBattement: Date.now(),
    });
    this.annoncerSpecialites();
  }

  get listeMicroAgents(): MicroAgent[] {
    return [...this.microAgents.values()];
  }

  get statistiques(): typeof this.stats & { noeudsDistant: number; fileLocale: number } {
    return {
      ...this.stats,
      noeudsDistant: this.noeudsDistants.size,
      fileLocale: this.fileLocale.length,
    };
  }

  get noeudsConnus(): NoeudDistant[] {
    return [...this.noeudsDistants.values()];
  }

  get tachesActives(): TacheAgent[] {
    return [...this.tachesOuvres.values()];
  }

  /** Spécialités réellement disponibles (locales). */
  get specialitesLocales(): TypeAgent[] {
    return [...this.agentsLocaux.keys()];
  }

  /* ---------------------------- tâches ---------------------------- */

  /**
   * Ouvre une tâche au nom du cortex : diffuse l'onde de tâche à
   * l'essaim ET l'exécute localement si la spécialité est présente.
   * Premier résultat reçu (local ou P2P) gagne — la déduplication
   * tacheId + premier-arrivé évite les comptes-rendus doubles.
   */
  ouvrirTache(
    type: TypeAgent,
    charge: Record<string, unknown>,
    priorite: PrioriteTache = "normale",
  ): TacheAgent {
    const tailleCharge = JSON.stringify(charge ?? {}).length;
    if (tailleCharge > BORNES_AGENTS.tailleChargeTache) {
      throw new Error(
        `Charge de tâche trop lourde (${tailleCharge} o > ${BORNES_AGENTS.tailleChargeTache} o) — les données volumineuses vivent dans le coffre local chiffré.`,
      );
    }
    const tache: TacheAgent = {
      id: `t-${this.idNoeud}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      charge,
      priorite,
      emiseA: Date.now(),
      emetteur: this.idNoeud,
      statut: "en-attente",
      delaiMs: BORNES_AGENTS.delaiOrphelin,
    };
    this.tachesOuvres.set(tache.id, tache);
    this.stats.tachesOuvres++;

    // Onde de tâche vers l'essaim (les pairs intéressés se réclament).
    this.noeud?.emettre({
      type: "tache",
      charge: { tache: { ...tache, statut: "en-attente" } },
    });

    // Exécution locale en parallèle si la spécialité existe ici.
    if (this.agentsLocaux.has(type)) {
      this.executerLocalement(tache);
    } else {
      this.surEvenement?.({
        type: "tache-distribuee",
        detail: `Tâche ${tache.type} diffusée à l'essaim (aucun agent local de cette spécialité).`,
      });
    }
    return tache;
  }

  /** Exécution par un agent local — résultat renvoyé au cortex émetteur. */
  private executerLocalement(tache: TacheAgent): void {
    const agent = this.agentsLocaux.get(tache.type)!;
    const micro = this.microAgents.get(tache.type)!;
    micro.etat = "actif";
    micro.charge = Math.min(1, micro.charge + 0.34);
    micro.dernierBattement = Date.now();
    tache.statut = "en-cours";
    tache.attribueA = this.idNoeud;

    try {
      const resultat = agent.executer(tache);
      tache.resultat = resultat;
      tache.statut = "terminee";
      micro.tachesTraitees++;
      this.stats.tachesExecutees++;
      micro.charge = Math.max(0, micro.charge - 0.34);
      micro.etat = "veille";

      if (this.tachesOuvres.has(tache.id)) {
        // Tâche ouverte ici (cortex local) : premier résultat gagne.
        this.conclureTache(tache);
      }
      // Compte-rendu au cortex émetteur (onde directe).
      this.noeud?.emettre({
        type: "resultat",
        vers: tache.emetteur,
        charge: {
          tacheId: tache.id,
          type: tache.type,
          resultat,
          noeud: this.idNoeud,
        } satisfies ChargeResultat,
      });
    } catch (e) {
      tache.statut = "echouee";
      micro.tachesEchouees++;
      micro.etat = "veille";
      this.surEvenement?.({
        type: "tache-echec",
        detail: `Agent ${tache.type} en échec : ${e instanceof Error ? e.message : "erreur inconnue"}.`,
      });
    }
  }

  /**
   * Conclut une tâche ouverte ici : premier résultat gagne, compte-rendu
   * au cortex (l'IA principale voit TOUT). La garde est un ensemble
   * dédié (jamais l'état de l'objet, muté par l'exécution elle-même).
   */
  private conclureTache(tache: TacheAgent): void {
    if (this.tachesResolues.has(tache.id)) return;
    this.tachesResolues.add(tache.id);
    if (this.tachesResolues.size > 1024) {
      this.tachesResolues = new Set([...this.tachesResolues].slice(-512));
    }
    const existante = this.tachesOuvres.get(tache.id);
    this.tachesOuvres.delete(tache.id);
    if (!existante) return;
    existante.statut = "terminee";
    existante.resultat = tache.resultat;
    existante.attribueA = tache.attribueA;
    this.stats.resultatsRecus++;
    this.stats.comptesRendus++;
    this.ia.recevoirCompteRendu(existante);
    this.surEvenement?.({
      type: "resultat",
      detail: existante.resultat?.resume ?? "Résultat reçu.",
    });
  }

  /**
   * Ré-attribution (résilience) : réémet une tâche orpheline, soit en
   * onde SOS vers l'essaim, soit en exécution locale de dernier recours.
   */
  reattribuer(tache: TacheAgent, noeudPerdu: string, generation: number): void {
    this.stats.rechutes++;
    if (generation >= BORNES_AGENTS.generationsMax) {
      this.surEvenement?.({
        type: "tache-abandon",
        detail: `Tâche ${tache.id} abandonnée après ${generation} ré-attributions — le cortex garde la main.`,
      });
      this.tachesOuvres.delete(tache.id);
      return;
    }
    const tacheGen: TacheAgent = { ...tache, statut: "orpheline" };
    if (this.agentsLocaux.has(tache.type)) {
      // Dernier recours immédiat : cet agent local prend le relais.
      this.surEvenement?.({
        type: "reattribution-locale",
        detail: `Onde orpheline récupérée localement (génération ${generation}).`,
      });
      this.executerLocalement({ ...tacheGen, emetteur: tache.emetteur });
      return;
    }
    this.noeud?.emettre({
      type: "sos",
      charge: { tache: tacheGen, noeudPerdu, generation } satisfies ChargeSos,
    });
  }

  /* ---------------------------- messages -------------------------- */

  /** Traite un message d'agent reçu par onde (appelé par le nœud P2P). */
  traiterMessage(message: MessageAgent): void {
    try {
      switch (message.type) {
        case "annonce":
          this.traiterAnnonce(message);
          break;
        case "battement":
          this.traiterBattement(message);
          break;
        case "tache":
          this.traiterTache(message);
          break;
        case "resultat":
          this.traiterResultat(message);
          break;
        case "sos":
          this.traiterSos(message);
          break;
        default:
          break; // fragment / compétence : gérés par leurs modules.
      }
    } catch {
      // Message malformé : ignoré, l'essaim continue.
    }
  }

  private traiterAnnonce(message: MessageAgent): void {
    const charge = message.charge as ChargeAnnonce | undefined;
    if (!charge?.specialites) return;
    const existant = this.noeudsDistants.get(message.de) ?? {
      id: message.de,
      nom: charge.nom,
      specialites: [],
      capacite: 1,
      amplitude: 1,
      dernierBattement: Date.now(),
    };
    existant.nom = charge.nom;
    existant.specialites = charge.specialites;
    existant.capacite = charge.capacite;
    existant.dernierBattement = Date.now();
    this.noeudsDistants.set(message.de, existant);
    // En réponse, on annonce aussi nos spécialités (présentation mutuelle).
    this.annoncerSpecialites();
  }

  private traiterBattement(message: MessageAgent): void {
    const charge = message.charge as ChargeBattement | undefined;
    if (!charge) return;
    const existant = this.noeudsDistants.get(message.de) ?? {
      id: message.de,
      nom: message.de,
      specialites: [],
      capacite: charge.capacite,
      amplitude: charge.amplitude,
      dernierBattement: Date.now(),
    };
    existant.amplitude = charge.amplitude;
    existant.capacite = charge.capacite;
    existant.dernierBattement = Date.now();
    this.noeudsDistants.set(message.de, existant);
  }

  private traiterTache(message: MessageAgent): void {
    const charge = message.charge as { tache?: TacheAgent } | undefined;
    const tache = charge?.tache;
    if (!tache || typeof tache.id !== "string") return;
    if (tache.emetteur === this.idNoeud) return; // notre propre onde (cascade)
    if (this.tachesRecues.has(tache.id)) return;
    this.tachesRecues.add(tache.id);
    if (this.tachesRecues.size > 512) {
      this.tachesRecues = new Set([...this.tachesRecues].slice(-256));
    }

    // On réclame la tâche si on a la spécialité ET de la capacité.
    const micro = this.microAgents.get(tache.type);
    if (!micro || micro.charge >= 0.9) return;
    this.executerLocalement({ ...tache, emetteur: tache.emetteur });
  }

  private traiterResultat(message: MessageAgent): void {
    const charge = message.charge as ChargeResultat | undefined;
    if (!charge?.tacheId) return;
    const tache = this.tachesOuvres.get(charge.tacheId);
    if (!tache || this.tachesResolues.has(charge.tacheId)) return; // premier résultat gagne
    tache.statut = "terminee";
    tache.resultat = charge.resultat;
    tache.attribueA = charge.noeud;
    this.conclureTache(tache);
  }

  private traiterSos(message: MessageAgent): void {
    const charge = message.charge as ChargeSos | undefined;
    if (!charge?.tache) return;
    // Un SOS n'est accepté que si l'onde est réellement orpheline chez nous.
    const micro = this.microAgents.get(charge.tache.type);
    if (!micro || micro.charge >= 0.9) return;
    this.surEvenement?.({
      type: "sos-recu",
      detail: `SOS accepté : relais de la tâche ${charge.tache.id} perdue par ${charge.noeudPerdu.slice(0, 8)}…`,
    });
    this.executerLocalement({ ...charge.tache, emetteur: charge.tache.emetteur });
  }

  /* ---------------------------- ondes de vie ---------------------- */

  /** Publie nos spécialités à l'essaim (annonce + battement immédiat). */
  annoncerSpecialites(): void {
    const capacite = 1 - (this.fileLocale.length / 8 || 0);
    this.noeud?.annoncer({
      nom: this.idNoeud,
      specialites: [...this.agentsLocaux.keys()],
      capacite: Math.max(0, capacite),
    });
  }

  private battre(): void {
    const capacite = Math.max(0, 1 - this.fileLocale.length / 8);
    this.noeud?.emettre({
      type: "battement",
      charge: { amplitude: 1, capacite, tachesEnCours: this.fileLocale.length } satisfies ChargeBattement,
    });
  }

  /**
   * Balayage : les tâches ouvertes ici sans battement du nœud assigné
   * sont déclarées orphelines (rupture de l'onde de vie) → ré-attribution.
   * Appelé par la sentinelle de résilience ; reste honnête en local pur
   * (les tâches locales ne s'auto-déclarent jamais orphelines).
   */
  balayer(): TacheAgent[] {
    const maintenant = Date.now();
    const orphelines: TacheAgent[] = [];
    for (const tache of this.tachesOuvres.values()) {
      if (tache.statut !== "en-cours" || !tache.attribueA) continue;
      if (tache.attribueA === this.idNoeud) continue; // local : protégé
      const noeud = this.noeudsDistants.get(tache.attribueA);
      const silence = maintenant - (noeud?.dernierBattement ?? tache.emiseA);
      if (!noeud || silence > BORNES_AGENTS.delaiOrphelin) {
        orphelines.push(tache);
      }
    }
    for (const tache of orphelines) {
      this.tachesOuvres.delete(tache.id);
      this.reattribuer(tache, tache.attribueA!, 1);
    }
    return orphelines;
  }

  /** Vu par la sentinelle : un nœud vient de rompre sa phase. */
  signalerRupture(noeudId: string): TacheAgent[] {
    const perdues: TacheAgent[] = [];
    for (const tache of this.tachesOuvres.values()) {
      if (tache.attribueA === noeudId && tache.statut === "en-cours") {
        perdues.push(tache);
        this.tachesOuvres.delete(tache.id);
      }
    }
    for (const tache of perdues) {
      this.reattribuer(tache, noeudId, 1);
    }
    if (this.noeudsDistants.has(noeudId)) {
      this.noeudsDistants.delete(noeudId);
    }
    return perdues;
  }

  /** File locale priorisée (tri par priorité puis ancienneté). */
  trierFile(): TacheAgent[] {
    return [...this.fileLocale].sort((a, b) => {
      const p = PRIORITES[a.priorite] - PRIORITES[b.priorite];
      return p !== 0 ? p : a.emiseA - b.emiseA;
    });
  }
}
