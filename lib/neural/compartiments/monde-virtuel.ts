/**
 * COMPARTIMENT SCIENCES GEN3 — LE MONDE VIRTUEL (demande propriétaire :
 * « pour les sciences, il existe dans le projet un monde virtuel qui doit
 * permettre à gen3 de simuler le fonctionnement du monde en virtuel pour
 * qu'il puisse reproduire à l'identique, et ça sert aussi de passerelle
 * entre gen3 et les IA des utilisateurs qui pourraient être entraînées »).
 *
 * DEUX RÔLES, UN MÊME COMPARTIMENT :
 *   1. CERVEAU SCIENTIFIQUE — Gen3 traduit une question de physique en
 *      spécification (l'interprète du Monde), SIMULE le phénomène
 *      (mécanique, thermique, fluidique, électromagnétisme, ondes, quantique,
 *      relativité — solveurs caps protégés) et formule la réponse en français :
 *      il reproduit le fonctionnement du monde au lieu de réciter un cours ;
 *   2. PASSERELLE À IA UTILISATRICES — une IA entraînable s'enregistre,
 *      reçoit des OBSERVATIONS (spécification + scalaire cible ANNONCÉ,
 *      valeur masquée), soumet ses PRÉDICTIONS, et reçoit un FEEDBACK
 *      mesuré (erreur relative, score 0..1) : le monde virtuel devient un
 *      environnement d'entraînement reproductible (déterministe) pour les
 *      agents des utilisateurs.
 *
 * HONNÊTETÉ : les caps du Monde (CAPS_MONDE) bornent TOUT calcul ; les
 * scores des agents sont des erreurs RELATIVES mesurées, jamais fabriquées ;
 * les anneaux sont bornés (agents 256, observations 256).
 */

import { interpreter } from "@/lib/monde/intention";
import { simuler } from "@/lib/monde/univers";
import type { SpecSimulation } from "@/lib/monde/univers";
import type { ResultatSimulation, Scalaire } from "@/lib/monde/types";

/** Seuil de confiance de l'interprète — en dessous, le compartiment refuse
 * (pas de simulation hasardeuse présentée comme science). */
export const SEUIL_CONFIANCE_MONDE = 0.5;

// ─── RÔLE 1 : LE CERVEAU SCIENTIFIQUE ────────────────────────────────────────

export interface ResultatMonde {
  readonly resolu: boolean;
  readonly texte: string;
  readonly modele: string;
  readonly titre: string;
  readonly comprehension: string;
  readonly confiance: number;
  readonly scalaires: readonly { nom: string; valeur: number; unite: string }[];
  readonly dureeMs: number;
}

function formaterNombre(x: number): string {
  if (!Number.isFinite(x)) return "invalide";
  const arrondi = Math.abs(x) >= 1e6 || (Math.abs(x) > 0 && Math.abs(x) < 1e-4)
    ? x.toExponential(4).replace(".", ",")
    : String(Math.round(x * 1e6) / 1e6).replace(".", ",");
  return arrondi;
}

/** Formule la réponse française du Monde : ce qui a été simulé, le modèle,
 * les valeurs clés mesurées — la reproduction virtuelle du phénomène. */
export function formuleReponseMonde(
  resultat: ResultatSimulation,
  comprehension: string,
  confiance: number,
): string {
  const valeurs = resultat.scalaires
    .slice(0, 6)
    .map((s: Scalaire) => `${s.nom} = ${formaterNombre(s.valeur)} ${s.unite}`)
    .join(" ; ");
  const avertissements = resultat.avertissements.length
    ? ` Avertissements : ${resultat.avertissements.join(" ; ")}.`
    : "";
  return (
    `[Compartiment sciences — monde virtuel] ${resultat.titre} (modèle : ${resultat.modele}). ` +
    `${comprehension} Simulation exécutée : ${resultat.explication} ` +
    (valeurs ? `Valeurs mesurées : ${valeurs}.` : "") +
    ` (confiance d'interprétation ${Math.round(confiance * 100)} %, calcul ${resultat.dureeMs} ms, caps du Monde appliqués.)` +
    avertissements
  );
}

export class CompartimentMondeGen3 {
  /**
   * Traduit une question de sciences en simulation du Monde et formule la
   * réponse. null si la question n'est pas une simulation reconnue avec
   * assez de confiance (le compartiment ne devine jamais).
   */
  repondre(question: string): ResultatMonde | null {
    const questionPropre = question.trim();
    if (questionPropre.length === 0 || questionPropre.length > 2000) return null;
    let interp;
    try {
      interp = interpreter(questionPropre);
    } catch {
      return null; // l'interprète est défensif — jamais une panne de chat
    }
    if (!interp || interp.confiance < SEUIL_CONFIANCE_MONDE) return null;
    let resultat: ResultatSimulation;
    try {
      resultat = simuler(interp.spec);
    } catch {
      return null; // une spécification hostile est refusée par les caps
    }
    return {
      resolu: true,
      texte: formuleReponseMonde(resultat, interp.comprehension, interp.confiance),
      modele: resultat.modele,
      titre: resultat.titre,
      comprehension: interp.comprehension,
      confiance: interp.confiance,
      scalaires: resultat.scalaires.map((s) => ({
        nom: s.nom,
        valeur: s.valeur,
        unite: s.unite,
      })),
      dureeMs: resultat.dureeMs,
    };
  }

  /** Les familles de simulation supportées (documentation honnête). */
  capacites(): readonly string[] {
    return [
      "projectile", "nCorps", "pendule", "ressort", "chuteLibre",
      "onde2D", "fentesYoung", "ondeLumiere", "particuleBoite", "paquetOnde",
      "diffusionChaleur", "gazParfait", "champElectrique", "circuitRLC",
      "dilatationTemps", "energieRelativiste", "redshift", "ecoulementCylindre",
      "torricelli", "ode", "racines", "integrale", "optimisation",
    ];
  }
}

// ─── RÔLE 2 : LA PASSERELLE À IA UTILISATRICES ───────────────────────────────

export const CAPACITE_AGENTS_PASSERELLE = 256;
export const CAPACITE_OBSERVATIONS_PASSERELLE = 256;

export interface AgentIaUtilisateur {
  readonly id: string;
  readonly nom: string;
  readonly enregistreA: number;
  observationsRecues: number;
  predictionsSoumises: number;
  scores: number[];
}

export interface ObservationMonde {
  readonly id: string;
  readonly scenario: string;
  readonly spec: SpecSimulation;
  /** Le scalaire à prédire (nom + unité) — sa VALEUR est masquée jusqu'à l'évaluation. */
  readonly cible: { nom: string; unite: string };
  /** Valeur réelle (réservée à l'évaluation — jamais renvoyée avant). */
  readonly valeurReelle: number;
  readonly emiseA: number;
  readonly predictions: Map<string, { valeur: number; horodatage: number }>;
  /** Résultat d'évaluation par agent (feedback d'entraînement). */
  readonly evaluations: Map<string, { erreurRelative: number; score: number }>;
}

export interface FeedbackEntrainement {
  readonly agentId: string;
  readonly observationId: string;
  readonly cible: { nom: string; unite: string };
  readonly prediction: number;
  readonly valeurReelle: number;
  readonly erreurRelative: number;
  /** score = max(0, 1 − erreurRelative) — 1 = prédiction exacte. */
  readonly score: number;
  readonly appreciation: string;
}

let compteurObservation = 0;

/**
 * LA PASSERELLE : Gen3 simule, les IA des utilisateurs observent, prédisent
 * et reçoivent un feedback mesuré — une boucle d'entraînement scientifique
 * reproductible (le Monde est déterministe : mêmes paramètres → même réalité).
 */
export class PasserelleIaUtilisateurs {
  private readonly agents = new Map<string, AgentIaUtilisateur>();
  private readonly ordreAgents: string[] = [];
  private readonly observations = new Map<string, ObservationMonde>();
  private readonly ordreObservations: string[] = [];
  private compteurAgents = 0;

  /** Enregistre une IA utilisateur entraînable (anneau borné). */
  enregistrerAgent(nom: string): { id: string; dejaEnregistree: boolean } | null {
    const nomPropre = nom.trim().slice(0, 80);
    if (nomPropre.length === 0) return null;
    // Déterministe : même nom → même agent (pas de doublon artificiel).
    const id = `iau_${fnv1a128(nomPropre)}`;
    const existante = this.agents.get(id);
    if (existante) return { id, dejaEnregistree: true };
    this.compteurAgents += 1;
    const agent: AgentIaUtilisateur = {
      id,
      nom: nomPropre,
      enregistreA: Date.now(),
      observationsRecues: 0,
      predictionsSoumises: 0,
      scores: [],
    };
    this.agents.set(id, agent);
    this.ordreAgents.push(id);
    if (this.ordreAgents.length > CAPACITE_AGENTS_PASSERELLE) {
      const evince = this.ordreAgents.splice(0, this.ordreAgents.length - CAPACITE_AGENTS_PASSERELLE);
      for (const e of evince) this.agents.delete(e);
    }
    return { id, dejaEnregistree: false };
  }

  /**
   * Gen3 émet une observation : il SIMULE le scénario (caps appliqués),
   * choisit le scalaire cible (demandé ou le premier mesuré) et publie
   * l'observation SANS la valeur — les IA doivent la prédire.
   */
  emettreObservation(
    spec: SpecSimulation,
    nomCible?: string,
  ): { observation: Omit<ObservationMonde, "valeurReelle" | "predictions" | "evaluations"> } | null {
    let resultat: ResultatSimulation;
    try {
      resultat = simuler(spec);
    } catch {
      return null; // spécification refusée par les caps du Monde
    }
    const cible = nomCible
      ? resultat.scalaires.find((s) => s.nom.toLowerCase() === nomCible.toLowerCase())
      : resultat.scalaires[0];
    if (!cible) return null;
    compteurObservation += 1;
    const id = `obs_${compteurObservation.toString(36).padStart(4, "0")}`;
    const observation: ObservationMonde = {
      id,
      scenario: resultat.titre,
      spec,
      cible: { nom: cible.nom, unite: cible.unite },
      valeurReelle: cible.valeur,
      emiseA: Date.now(),
      predictions: new Map(),
      evaluations: new Map(),
    };
    this.observations.set(id, observation);
    this.ordreObservations.push(id);
    if (this.ordreObservations.length > CAPACITE_OBSERVATIONS_PASSERELLE) {
      const evince = this.ordreObservations.splice(0, this.ordreObservations.length - CAPACITE_OBSERVATIONS_PASSERELLE);
      for (const e of evince) this.observations.delete(e);
    }
    return {
      observation: {
        id,
        scenario: observation.scenario,
        spec: observation.spec,
        cible: observation.cible,
        emiseA: observation.emiseA,
      },
    };
  }

  /** Une IA utilisateur soumet sa prédiction sur la valeur cible masquée. */
  soumettrePrediction(agentId: string, observationId: string, valeur: number): boolean {
    const agent = this.agents.get(agentId);
    const observation = this.observations.get(observationId);
    if (!agent || !observation) return false;
    if (!Number.isFinite(valeur)) return false;
    if (observation.predictions.has(agentId)) return false; // une prédiction par agent
    observation.predictions.set(agentId, { valeur, horodatage: Date.now() });
    agent.predictionsSoumises += 1;
    agent.observationsRecues += 1;
    return true;
  }

  /**
   * ÉVALUATION (le feedback d'entraînement) : compare chaque prédiction à
   * la valeur RÉELLE mesurée par la simulation — erreur relative et score
   * 0..1 mesurés, jamais inventés. Idempotent : réévaluer ne change rien.
   */
  evaluerObservation(observationId: string): readonly FeedbackEntrainement[] | null {
    const observation = this.observations.get(observationId);
    if (!observation) return null;
    const feedbacks: FeedbackEntrainement[] = [];
    for (const [agentId, prediction] of observation.predictions) {
      const dejaEvalue = observation.evaluations.get(agentId);
      const erreurRelative = dejaEvalue
        ? dejaEvalue.erreurRelative
        : Math.abs(prediction.valeur - observation.valeurReelle) /
          (Math.abs(observation.valeurReelle) || 1);
      const score = Math.max(0, 1 - erreurRelative);
      if (!dejaEvalue) {
        observation.evaluations.set(agentId, { erreurRelative, score });
        const agent = this.agents.get(agentId);
        if (agent) agent.scores.push(score);
      }
      feedbacks.push({
        agentId,
        observationId,
        cible: observation.cible,
        prediction: prediction.valeur,
        valeurReelle: observation.valeurReelle,
        erreurRelative: Math.round(erreurRelative * 1e6) / 1e6,
        score: Math.round(score * 1e6) / 1e6,
        appreciation:
          score >= 0.95
            ? "prédiction quasi exacte — le modèle de l'agent reproduit la physique"
            : score >= 0.7
              ? "prédiction proche — ajuster les paramètres appris"
              : "prédiction éloignée — revoir le modèle entraîné",
      });
    }
    return feedbacks;
  }

  /** Lit une observation sans jamais révéler la valeur réelle (avant éval). */
  litObservation(observationId: string): Omit<ObservationMonde, "valeurReelle" | "predictions" | "evaluations"> | null {
    const o = this.observations.get(observationId);
    if (!o) return null;
    return { id: o.id, scenario: o.scenario, spec: o.spec, cible: o.cible, emiseA: o.emiseA };
  }

  /** Statistiques honnêtes de la passerelle. */
  statistiques(): {
    agents: number;
    observations: number;
    predictions: number;
    evaluations: number;
    scoreMoyen: number | null;
  } {
    let predictions = 0;
    let evaluations = 0;
    let sommeScores = 0;
    for (const o of this.observations.values()) {
      predictions += o.predictions.size;
      evaluations += o.evaluations.size;
      for (const e of o.evaluations.values()) sommeScores += e.score;
    }
    for (const a of this.agents.values()) {
      /* scores agrégés au niveau des observations — comptés au-dessus */
      void a;
    }
    return {
      agents: this.agents.size,
      observations: this.observations.size,
      predictions,
      evaluations,
      scoreMoyen: evaluations > 0 ? Math.round((sommeScores / evaluations) * 1e4) / 1e4 : null,
    };
  }

  litAgents(): readonly { id: string; nom: string; predictions: number; scoreMoyen: number | null }[] {
    return this.ordreAgents
      .map((id) => this.agents.get(id))
      .filter((a): a is AgentIaUtilisateur => Boolean(a))
      .map((a) => ({
        id: a.id,
        nom: a.nom,
        predictions: a.predictionsSoumises,
        scoreMoyen:
          a.scores.length > 0
            ? Math.round((a.scores.reduce((s, v) => s + v, 0) / a.scores.length) * 1e4) / 1e4
            : null,
      }));
  }
}

/** FNV-1a 64 bits (2 passes) — identifiant d'agent déterministe. */
function fnv1a128(chaine: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < chaine.length; i++) {
    const c = chaine.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
