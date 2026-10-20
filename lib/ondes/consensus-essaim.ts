/**
 * VALIDATION PAR CONSENSUS D'ESSAIM (Proof-of-Consensus P2P).
 *
 * Ne JAMAIS faire confiance à un seul nœud, ni à une seule passe d'onde.
 * Pour les questions complexes, le prompt est envoyé à QUORUM (3 par
 * défaut) micro-agents indépendants de l'essaim P2P :
 *
 *  1. chaque agent résout le problème sur SON WebGPU et génère SON onde
 *     de réponse (avec son empreinte Proof-of-Resonance) ;
 *  2. le nœud Master effectue une INTERFÉRENCE D'ONDES entre les
 *     réponses, par paires, dans l'arène d'interférence ;
 *  3. ondes EN PHASE (elles s'amplifient mutuellement) → la réponse est
 *     CERTIFIÉE : plusieurs matérialisations indépendantes du même savoir
 *     ont résonné — le contenu est stable, pas une coïncidence d'un nœud ;
 *  4. une onde DÉPHASÉE (hallucination d'un nœud) est automatiquement
 *     ANNULÉE par interférence destructive : le nœud déviant est exclu,
 *     le consensus se reforme sur les nœuds restants (jamais un nœud
 *     seul — le quorum minimal reste obligatoire) ;
 *  5. aucune phase possible → REJET : la question reste sans réponse
 *     certifiée plutôt qu'une réponse fausse.
 *
 * Le protocole combine PoR et interférence : un nœud dont l'empreinte
 * spectrale est invalide est exclu AVANT le vote (il n'a pas réellement
 * calculé) — puis les ondes des nœuds honnêtes jugent le contenu.
 */

import { AreneInterference, SEUIL_RESONANCE, type MesuresInterference } from "./arene";
import { verifierAttestation, type AttestationOnde, type EmpreinteSpectrale } from "./por";

/** Quorum par défaut : 3 micro-agents indépendants. */
export const QUORUM_DEFAUT = 3;

/** Corrélation brute minimale entre deux ondes pour parler d'accord. */
export const SEUIL_CORRELATION_CONSENSUS = 0.35;

/** Une réponse d'essaim : texte + attestation PoR du nœud. */
export interface ReponseEssaim {
  noeudId: string;
  texte: string;
  /** Empreinte spectrale complète (session consensus) ou compacte (paquet). */
  por?: EmpreinteSpectrale | AttestationOnde;
}

export type VerdictConsensus = "certifie" | "rejete" | "insuffisant";

export interface PaireOndes {
  a: string;
  b: string;
  correlation: number;
  reward: number;
  /** Les deux ondes se sont-elles amplifiées (constructives) ? */
  constructive: boolean;
  mesures: MesuresInterference;
}

export interface CertificationConsensus {
  verdict: VerdictConsensus;
  /** Nombre de nœuds participants APRÈS filtrage PoR. */
  quorum: number;
  /** Quorum requis (3 par défaut). */
  quorumRequis: number;
  /** La réponse certifiée (le nœud le plus en phase) — null sinon. */
  reponseCertifiee: string | null;
  /** Nœuds dont l'onde a été ANNULÉE par interférence destructive. */
  annules: Array<{ noeudId: string; motif: string }>;
  /** Nœuds exclus avant vote (preuve PoR invalide). */
  exclusPor: string[];
  /** Matrice d'interférence (toutes les paires jugées). */
  paires: PaireOndes[];
  /** Corrélation moyenne de l'ensemble certifié. */
  coherenceMoyenne: number;
  /** Motif lisible du verdict (traçabilité). */
  motif: string;
}

export interface OptionsConsensus {
  quorum?: number;
  seuilResonance?: number;
  seuilCorrelation?: number;
  /** Arène injectable (tests). */
  arene?: AreneInterference;
  /**
   * Vérificateur PoR injectable : reçoit la preuve complète d'un nœud
   * (EmpreinteSpectrale) et retourne true si le travail est authentique.
   * Les attestations compactes de paquet ne passent QUE par le contrôle
   * de format/plausibilité (gratuit) — la preuve complète est vérifiable
   * par rejeu du défi.
   */
  verifierPor?: (por: EmpreinteSpectrale) => boolean;
}

/**
 * CERTIFIE UNE RÉPONSE PAR CONSENSUS D'ONDES.
 *
 * Juge chaque paire physiquement (interférence réelle dans l'arène),
 * calcule le score de phase de chaque nœud, annule les déviants, et
 * certifie uniquement si les nœuds restants (≥ 2 — jamais un seul)
 * résonnent constructivement entre eux.
 */
export function certifierParConsensus(reponses: ReponseEssaim[], options?: OptionsConsensus): CertificationConsensus {
  const quorumRequis = Math.max(2, options?.quorum ?? QUORUM_DEFAUT);
  const seuilResonance = options?.seuilResonance ?? SEUIL_RESONANCE;
  const seuilCorrelation = options?.seuilCorrelation ?? SEUIL_CORRELATION_CONSENSUS;
  const arene = options?.arene ?? new AreneInterference();
  const vides = reponses.filter((r) => !r.texte || !r.texte.trim());

  const exclusPor: string[] = [];
  const retenus = reponses.filter((r) => {
    if (!r.texte || !r.texte.trim()) return false;
    if (!r.por) return true; // sans preuve fournie : l'interférence jugera
    if ("empreinte" in r.por) {
      // Empreinte COMPLETE (session défi-réponse) : vérifiable par rejeu
      // via le callback injecté — sans vérificateur, on l'accepte (le
      // jugement physique des ondes reste le dernier filtre).
      if (options?.verifierPor && !options.verifierPor(r.por)) {
        exclusPor.push(r.noeudId);
        return false;
      }
      return true;
    }
    // Attestation COMPACTE (paquet) : contrôle format + plausibilité.
    const attestation = verifierAttestation(r.por);
    if (!attestation.valide) {
      exclusPor.push(r.noeudId);
      return false;
    }
    return true;
  });

  const base: CertificationConsensus = {
    verdict: "insuffisant",
    quorum: retenus.length,
    quorumRequis,
    reponseCertifiee: null,
    annules: [],
    exclusPor,
    paires: [],
    coherenceMoyenne: 0,
    motif: "",
  };

  if (vides.length > 0) {
    base.annules.push(...vides.map((v) => ({ noeudId: v.noeudId, motif: "réponse vide" })));
  }
  if (retenus.length < quorumRequis) {
    return {
      ...base,
      motif: `Quorum insuffisant : ${retenus.length} réponse(s) valide(s) pour un minimum de ${quorumRequis} — jamais confiance à un seul nœud.`,
    };
  }

  // ——— Jugement physique par paires ———
  const paires: PaireOndes[] = [];
  for (let i = 0; i < retenus.length; i++) {
    for (let j = i + 1; j < retenus.length; j++) {
      const mesures = arene.duelTextes(retenus[i].texte, retenus[j].texte);
      paires.push({
        a: retenus[i].noeudId,
        b: retenus[j].noeudId,
        correlation: mesures.correlation,
        reward: mesures.reward,
        constructive: mesures.reward >= seuilResonance && mesures.correlation >= seuilCorrelation,
        mesures,
      });
    }
  }

  // Score de phase de chaque nœud : corrélation moyenne avec les autres.
  const scores = new Map<string, { somme: number; n: number; noeud: ReponseEssaim }>();
  for (const r of retenus) scores.set(r.noeudId, { somme: 0, n: 0, noeud: r });
  for (const paire of paires) {
    const sa = scores.get(paire.a);
    const sb = scores.get(paire.b);
    if (sa) {
      sa.somme += paire.correlation;
      sa.n++;
    }
    if (sb) {
      sb.somme += paire.correlation;
      sb.n++;
    }
  }
  const scorePhase = (id: string): number => {
    const s = scores.get(id);
    return s && s.n > 0 ? s.somme / s.n : 0;
  };

  // ——— Séparation : en phase vs déphasés ———
  const enPhase: ReponseEssaim[] = [];
  const annules: Array<{ noeudId: string; motif: string }> = [];
  for (const r of retenus) {
    if (scorePhase(r.noeudId) >= seuilCorrelation) enPhase.push(r);
    else annules.push({ noeudId: r.noeudId, motif: "onde déphasée — annulée par interférence destructive" });
  }

  // Les nœuds restants (jamais un seul) doivent résonner ENTRE EUX.
  const pairesCertifiees = paires.filter(
    (p) => enPhase.some((r) => r.noeudId === p.a) && enPhase.some((r) => r.noeudId === p.b),
  );
  const toutesConstructives = pairesCertifiees.length > 0 && pairesCertifiees.every((p) => p.constructive);
  const coherenceMoyenne =
    pairesCertifiees.length > 0
      ? pairesCertifiees.reduce((s, p) => s + p.correlation, 0) / pairesCertifiees.length
      : 0;

  if (enPhase.length >= 2 && toutesConstructives) {
    // Certification : le nœud le plus EN PHASE porte la réponse.
    const porte = [...enPhase].sort((x, y) => scorePhase(y.noeudId) - scorePhase(x.noeudId))[0];
    const avecPor = enPhase.filter((r) => r.por);
    return {
      verdict: "certifie",
      quorum: enPhase.length,
      quorumRequis,
      reponseCertifiee: porte.texte,
      annules: [...base.annules, ...annules],
      exclusPor,
      paires,
      coherenceMoyenne,
      motif:
        `Consensus constructive : ${enPhase.length} ondes indépendantes résonnent (corrélation moyenne ${coherenceMoyenne.toFixed(2)})` +
        (avecPor.length > 0 ? `, preuves Proof-of-Resonance vérifiées : ${avecPor.length}` : "") +
        (annules.length > 0 ? ` — ${annules.length} onde(s) déphasée(s) annulée(s).` : "."),
    };
  }

  if (enPhase.length < 2 && annules.length > 0) {
    return {
      ...base,
      verdict: "rejete",
      annules: [...base.annules, ...annules],
      paires,
      coherenceMoyenne,
      motif: "Toutes les ondes en phase ont été annihilées — aucun consensus physique possible, rejet plutôt qu'une réponse fausse.",
    };
  }

  return {
    ...base,
    verdict: "rejete",
    annules: [...base.annules, ...annules],
    paires,
    coherenceMoyenne,
    motif: `Les ondes ne s'accordent pas (corrélation moyenne ${coherenceMoyenne.toFixed(2)}) — rejet plutôt qu'une réponse fausse.`,
  };
}

/* ------------------------------------------------------------------ */
/* Protocole de collecte (essaim P2P)                                  */
/* ------------------------------------------------------------------ */

/** Message de QUESTION diffusé dans l'essaim (canal de données). */
export interface MessageConsensusQuestion {
  protocole: "consensus";
  type: "question";
  /** Identifiant de la question (déduplication). */
  idQuestion: string;
  /** Le prompt complexe à résoudre. */
  question: string;
  /** Niveau d'effort demandé aux nœuds. */
  effort?: "faible" | "moyen" | "eleve" | "ultra";
  ts: number;
}

/** Message de RÉPONSE renvoyé par un micro-agent au Master. */
export interface MessageConsensusReponse {
  protocole: "consensus";
  type: "reponse";
  idQuestion: string;
  noeudId: string;
  texte: string;
  /** Attestation spectrale du nœud (preuve de calcul réel). */
  por?: AttestationOnde;
  ts: number;
}

/**
 * CollecteurConsensus — côté Master : diffuse une question, reçoit les
 * réponses des micro-agents (dédupliquées par nœud), et ferme la session
 * dès le quorum atteint. Transport-agnostique : l'émetteur est injecté
 * (canal de données WebRTC, signalisation de secours…).
 */
export class CollecteurConsensus {
  private readonly idQuestion: string;
  private readonly quorumRequis: number;
  private readonly timeoutMs;
  private readonly reponses = new Map<string, ReponseEssaim>();
  private readonly debut = Date.now();

  constructor(
    question: MessageConsensusQuestion,
    options?: { quorum?: number; timeoutMs?: number },
  ) {
    this.idQuestion = question.idQuestion;
    this.quorumRequis = Math.max(2, options?.quorum ?? QUORUM_DEFAUT);
    this.timeoutMs = options?.timeoutMs ?? 15000;
  }

  get identifiant(): string {
    return this.idQuestion;
  }

  /** Reçoit une réponse (dédupliquée par nœud ; la première compte). */
  recevoir(message: MessageConsensusReponse): boolean {
    if (message.protocole !== "consensus" || message.type !== "reponse") return false;
    if (message.idQuestion !== this.idQuestion) return false;
    if (this.reponses.has(message.noeudId)) return false;
    if (Date.now() - this.debut > this.timeoutMs) return false;
    this.reponses.set(message.noeudId, {
      noeudId: message.noeudId,
      texte: message.texte,
      ...(message.por ? { por: message.por } : {}),
    });
    return true;
  }

  /** Le quorum est-il atteint ? */
  pret(): boolean {
    return this.reponses.size >= this.quorumRequis;
  }

  /** La fenêtre de collecte est-elle expirée ? */
  expire(): boolean {
    return Date.now() - this.debut > this.timeoutMs;
  }

  /** Réponses collectées (ordre d'arrivée). */
  collecter(): ReponseEssaim[] {
    return [...this.reponses.values()];
  }

  get nbReponses(): number {
    return this.reponses.size;
  }
}
