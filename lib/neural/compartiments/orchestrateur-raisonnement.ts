/**
 * COMPARTIMENT RAISONNEMENT GEN3 — L'ORCHESTRATEUR (demande propriétaire :
 * « crée un système qui permet à gen3 de raisonner et de réfléchir à chaque
 * requête en se servant de ses connaissances »).
 *
 * CYCLE DE RAISONNEMENT (exécuté pour CHAQUE requête qui atteint la chaîne
 * de composition du moteur) :
 *   1. ANALYSE — l'intention est détectée : calcul (compartiment math),
 *      simulation (compartiment sciences/monde), exécution (compartiment
 *      code/terminal), ou connaissance (corpus + mémoires) ; le domaine
 *      est classé par la mémoire de domaines ;
 *   2. RAPPEL — l'état du compartiment concerné est rappelé (comptabilité
 *      1 Go, sources) : gen3 se sert de ce qu'il sait posséder ;
 *   3. CANDIDATS — chaque voie de réponse sollicitée produit un candidat
 *      (calcul exact, simulation, exécution sandbox) ;
 *   4. ÉVALUATION — les candidats sont notés (exactitude du calcul,
 *      confiance de l'interprète, code de sortie du terminal) ;
 *   5. CHOIX ARGUMENTÉ — le meilleur candidat est élu AVEC sa raison ;
 *      la délibération entière est inscrite dans un anneau borné (256) :
 *      gen3 relit son propre raisonnement.
 *
 * NON-RÉGRESSION STRUCTURELLE : pour une intention « connaissance » — ou
 * si aucun compartiment ne produit de candidat — l'orchestrateur renvoie
 * null et le moteur procède EXACTEMENT comme avant (corpus prioritaire →
 * pont vocation → cortex) : le raisonnement ajoute, il ne remplace rien.
 */

import {
  formuleReponse,
  type ResultatCalcul,
} from "./moteur-math";
import type { CompartimentMondeGen3 } from "./monde-virtuel";
import type { TerminalVirtuelGen3 } from "./terminal-virtuel";

export type IntentionRequete = "calcul" | "simulation" | "execution" | "connaissance";

export interface CandidatRaisonnement {
  readonly compartiment: "math" | "monde" | "terminal";
  readonly servi: boolean;
  readonly texte: string;
  /** Score du candidat (0..1+) — exactitude du calcul, confiance, exit. */
  readonly score: number;
}

export interface TraceRaisonnement {
  readonly requete: string;
  readonly intention: IntentionRequete;
  /** Domaine classé par la mémoire de domaines (null si inconnu). */
  readonly domaine: string | null;
  /** État du compartiment visé (rappel) — null si intention connaissance. */
  readonly rappel: {
    readonly cle: string;
    readonly octetsPhysiques: number;
    readonly tauxCouverture: number;
  } | null;
  readonly candidats: readonly CandidatRaisonnement[];
  /** Le compartiment élu (null = délégation au chemin de connaissances). */
  readonly elu: CandidatRaisonnement["compartiment"] | null;
  /** La raison ARGUMENTÉE du choix (toujours remplie — y compris délégation). */
  readonly raison: string;
  readonly horodatage: number;
}

export interface ResultatOrchestration {
  readonly texte: string;
  readonly source: "compartiment_math" | "compartiment_monde" | "compartiment_terminal";
  readonly trace: TraceRaisonnement;
}

export const CAPACITE_MEMOIRE_RAISONNEMENT = 256;

/** Commandes du terminal reconnues comme intention « exécution » — la
 * requête adresse EXPLICITEMENT l'organe d'exécution. */
const PREFIXES_EXECUTION = /^(js|calc|monde|memoire|sources|etat|historique|aide)\b/;

export interface ContratMemoireRaisonnement {
  identifieDomaine(motif: string): string | null;
  etatCompartiment(domaine: string, capacite: string): { cle: string; octetsPhysiques: number; tauxCouverturePhysique: number };
}

export interface ParametresOrchestrateur {
  readonly math?: {
    resoudreProbleme(q: string): ResultatCalcul;
  };
  readonly monde?: Pick<CompartimentMondeGen3, "repondre">;
  readonly terminal?: Pick<TerminalVirtuelGen3, "executerCommande">;
  readonly memoireDomaines?: ContratMemoireRaisonnement;
}

export class OrchestrateurRaisonnementGen3 {
  private readonly traces: TraceRaisonnement[] = [];

  constructor(private readonly params: ParametresOrchestrateur) {}

  /**
   * RAISONNE sur la requête (cycle complet ci-dessus) et retourne la
   * réponse du compartiment élu — ou null si la connaissance doit répondre
   * (le moteur poursuit alors son chemin historique, inchangé).
   */
  resoudre(requete: string): ResultatOrchestration | null {
    const requetePropre = requete.trim();
    if (requetePropre.length === 0) return null;

    // 1. ANALYSE — intention + domaine classé.
    const estExecution = PREFIXES_EXECUTION.test(requetePropre.toLowerCase());
    const intention: IntentionRequete = estExecution
      ? "execution"
      : "connaissance"; // affiné ci-dessous par les candidats réels

    // 2. RAPPEL — l'état du compartiment visé par le domaine détecté.
    const domaine = this.params.memoireDomaines?.identifieDomaine(requetePropre) ?? null;
    let rappel: TraceRaisonnement["rappel"] = null;
    if (domaine && this.params.memoireDomaines && intention !== "execution") {
      const etat = this.params.memoireDomaines.etatCompartiment(domaine, "texte");
      rappel = {
        cle: etat.cle,
        octetsPhysiques: etat.octetsPhysiques,
        tauxCouverture: etat.tauxCouverturePhysique,
      };
    }

    // 3. CANDIDATS — chaque compartiment sollicité produit un candidat.
    const candidats: CandidatRaisonnement[] = [];

    // 3a. EXÉCUTION — la requête s'adresse explicitement au terminal.
    if (intention === "execution" && this.params.terminal) {
      const t = this.params.terminal.executerCommande(requetePropre);
      candidats.push({
        compartiment: "terminal",
        servi: t.exitCode === 0,
        texte: t.sortie,
        score: t.exitCode === 0 ? 1 : 0,
      });
    }

    // 3b. CALCUL — le compartiment math résout (familles documentées).
    if (this.params.math && !estExecution) {
      const c = this.params.math.resoudreProbleme(requetePropre);
      if (c.resolu && c.valeur !== null) {
        candidats.push({
          compartiment: "math",
          servi: true,
          texte: formuleReponse(c),
          score: 1, // un calcul exact est une preuve, pas une approximation
        });
      }
    }

    // 3c. SIMULATION — le monde virtuel reproduit le phénomène.
    if (this.params.monde && !estExecution) {
      const m = this.params.monde.repondre(requetePropre);
      if (m && m.confiance >= 0.5) {
        candidats.push({
          compartiment: "monde",
          servi: true,
          texte: m.texte,
          score: 0.9 * m.confiance, // simulation physique : très fiable, confiance pondérée
        });
      }
    }

    // 4. ÉVALUATION — le meilleur candidat servi.
    const elu = [...candidats]
      .filter((c) => c.servi)
      .sort((a, b) => b.score - a.score)[0] ?? null;

    // 5. CHOIX ARGUMENTÉ + TRACE.
    let raison: string;
    if (elu) {
      raison =
        elu.compartiment === "math"
          ? "intention calcul détectée : le compartiment math a CALCULÉ la réponse exacte avec ses étapes (preuve, pas récitation)"
          : elu.compartiment === "monde"
            ? "intention simulation : le monde virtuel a reproduit le phénomène (solveur à caps, confiance de l'interprète suffisante)"
            : "intention exécution : le terminal virtuel a exécuté la commande en sandbox (sortie vérifiée, exit 0)";
    } else if (candidats.length > 0) {
      raison = `compartiment(s) sollicité(s) (${candidats.map((c) => c.compartiment).join(", ")}) sans réponse servable : délégation au chemin de connaissances (corpus → vocation → cortex)`;
    } else {
      raison = "intention connaissance : aucun compartiment calculable sollicité — le savoir appris (corpus + mémoires + réflexion) répond, comme avant";
    }

    const trace: TraceRaisonnement = {
      requete: requetePropre.slice(0, 300),
      intention: elu
        ? elu.compartiment === "math"
          ? "calcul"
          : elu.compartiment === "monde"
            ? "simulation"
            : "execution"
        : intention === "execution"
          ? "execution"
          : "connaissance",
      domaine,
      rappel,
      candidats,
      elu: elu?.compartiment ?? null,
      raison,
      horodatage: Date.now(),
    };
    this.traces.push(trace);
    if (this.traces.length > CAPACITE_MEMOIRE_RAISONNEMENT) {
      this.traces.splice(0, this.traces.length - CAPACITE_MEMOIRE_RAISONNEMENT);
    }

    if (!elu) return null;
    return {
      texte: elu.texte,
      source:
        elu.compartiment === "math"
          ? "compartiment_math"
          : elu.compartiment === "monde"
            ? "compartiment_monde"
            : "compartiment_terminal",
      trace,
    };
  }

  /** La dernière délibération (pour le chat : gen3 peut montrer son raisonnement). */
  dernierRaisonnement(): TraceRaisonnement | null {
    return this.traces[this.traces.length - 1] ?? null;
  }

  /** L'anneau des délibérations (chronologique, borné). */
  lireRaisonnements(): readonly TraceRaisonnement[] {
    return this.traces;
  }

  viderRaisonnements(): void {
    this.traces.length = 0;
  }

  /** Statistiques honnêtes du raisonnement. */
  statistiques(): {
    total: number;
    resolus: number;
    delegues: number;
    parIntention: Record<IntentionRequete, number>;
    tauxResolution: number;
  } {
    const parIntention: Record<IntentionRequete, number> = {
      calcul: 0,
      simulation: 0,
      execution: 0,
      connaissance: 0,
    };
    let resolus = 0;
    for (const t of this.traces) {
      parIntention[t.intention] += 1;
      if (t.elu) resolus += 1;
    }
    return {
      total: this.traces.length,
      resolus,
      delegues: this.traces.length - resolus,
      parIntention,
      tauxResolution: this.traces.length > 0 ? resolus / this.traces.length : 0,
    };
  }
}
