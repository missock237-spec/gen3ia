/**
 * PROTOCOLE DE L'ESSAIM MÉDIA GEN3 — types et bornes.
 *
 * VISION UTILISATEUR (traduite en ingénierie honnête) :
 *  1. à chaque inscription/connexion, un PETIT AGENT gen3 se télécharge dans
 *     le cache du navigateur (Service Worker /gen3-agent/) ;
 *  2. les agents sont reliés à l'IA centrale par des ONDES (canal SSE
 *     « onde porteuse » + battements POST — l'analogie radio est assumée,
 *     le transport réel est HTTPS) ;
 *  3. chaque requête reçue par un agent est envoyée à l'IA centrale ;
 *  4. l'IA centrale SÉLECTIONNE LES 5 MEILLEURS APPAREILS (GPU le plus
 *     capable d'abord) et distribue à chacun UNE PARTIE de la tâche à
 *     résoudre via son WebGPU ;
 *  5. les résultats remontent à l'IA centrale qui LES ASSOCIE (fusion
 *     MP4/WAV) puis renvoie l'œuvre finale à l'agent demandeur → utilisateur ;
 *  6. si un agent TRAITE une partie et se DÉCONNECTE BRUSQUEMENT, la
 *     sentinelle de l'IA centrale RELANCE sa part vers un autre agent.
 *
 * Ce module est PUR (aucune dépendance Node, aucun I/O) : il sert à la
 * fois au serveur (registre + orchestrateur) et au navigateur (agent).
 */

export type TypeMédiaEssaim = "image" | "voice" | "video";

/** États d'un fragment de travail (une « part » de tâche). */
export type ÉtatFragment =
  | "en-attente"
  | "attribue"
  | "en-cours"
  | "termine"
  | "echoue";

/** États d'un job d'essaim complet. */
export type ÉtatJobEssaim =
  | "planifie"
  | "en-cours"
  | "fusion"
  | "termine"
  | "echoue";

/** Capacités GPU déclarées par un agent à chaque battement d'onde. */
export interface CapacitésNoeud {
  /** WebGPU disponible (sinon le nœud ne peut pas exécuter de fragment). */
  webgpu: boolean;
  /** Mémoire max d'un buffer GPU (Go) — critère principal du score. */
  memoireGo?: number;
  /** Nom d'adaptateur (ex. « nvidia ada », « apple m2 »). */
  adaptateur?: string;
  /** Features WebGPU (shader-f16, timestamp-query…). */
  features?: string[];
  /** User-Agent simplifié (os/navigateur) pour la plaque d'identité. */
  appareil?: string;
}

/** Un nœud de l'essaim : un navigateur connecté qui porte l'agent gen3. */
export interface NoeudEssaim {
  noeudId: string;
  userId: string;
  capacités: CapacitésNoeud;
  /** Score de capacité GPU ∈ [0, 1] — recalculé à chaque battement. */
  score: number;
  /** Nombre de fragments actuellement en cours sur ce nœud. */
  charge: number;
  /** Nombre total de fragments terminés avec succès (réputation). */
  succès: number;
  /** Battements ratés consécutifs (sentinelle). */
  ratés: number;
  /** ms epoch du dernier battement d'onde reçu. */
  dernierBattement: number;
  /** ms epoch de l'annonce initiale. */
  annoncéA: number;
}

/**
 * Un FRAGMENT : une part atomique de tâche exécutable via WebGPU.
 *  - vidéo  → 1 keyframe SD (seed dérivée) ;
 *  - voix   → 1 segment de texte (≤ BORNES.tailleSegment) ;
 *  - image  → l'image entière (1 seul fragment).
 */
export interface FragmentTravail {
  fragmentId: string;
  jobId: string;
  kind: TypeMédiaEssaim;
  /** Rang du fragment dans le plan (0-based). */
  index: number;
  /** Nombre total de fragments du plan. */
  total: number;
  état: ÉtatFragment;
  /** Nœud assigné (absent tant que en-attente). */
  noeudId?: string;
  /** ms epoch d'attribution (sentinelle de relance). */
  attribueA?: number;
  /** Génération de relance (0 = attribué d'origine). */
  génération: number;
  /** Charge utile exécutable (dépend du kind — voir planificateur). */
  charge: ChargeFragment;
  /** Octets du résultat (une fois terminé). */
  tailleRésultat?: number;
}

/** Charge exécutable d'un fragment (JSON compact, jamais de binaire). */
export type ChargeFragment =
  | {
      sous: "keyframe";
      prompt: string;
      ratio: string;
      seed: number;
      steps: number;
      guidance: number;
      largeur: number;
      hauteur: number;
    }
  | {
      sous: "segment";
      texte: string;
      voix: string;
      vitesse: number;
    }
  | {
      sous: "image";
      prompt: string;
      ratio: string;
      seed: number;
      steps: number;
      guidance: number;
    };

/** Un job d'essaim : la requête d'un utilisateur décomposée en fragments. */
export interface JobEssaim {
  jobId: string;
  conversationId: string;
  userId: string;
  kind: TypeMédiaEssaim;
  prompt: string;
  ratio?: string;
  duréeSecondes?: number;
  /** Job d'origine émis par le flux webgpu_media (traçabilité). */
  jobIdOrigine?: string;
  état: ÉtatJobEssaim;
  fragments: FragmentTravail[];
  /** Résultat fusionné (URL persistée R2, une fois terminé). */
  résultat?: { url: string; kind: TypeMédiaEssaim; taille: number };
  /** Livraison (message + artefact persistés par la complétion centrale). */
  livraison?: { message: Record<string, unknown>; artifact: Record<string, unknown> };
  /** Journal de relance (transparence utilisateur). */
  relances: Array<{ ts: number; fragmentId: string; noeudPerdu: string; noeudRelais?: string }>;
  crééA: number;
  terminéA?: number;
  erreur?: string;
}

/** Bornes du protocole (honnêteté : tout est plafonné explicitement). */
export const BORNES_ESSAIM = {
  /** L'IA centrale retient AU PLUS les 5 meilleurs appareils par job. */
  équipeMax: 5,
  /** Battement d'onde attendu toutes les 12 s (client). */
  périodeBattementMs: 12_000,
  /** Silence au-delà duquel un nœud est déclaré déconnecté. */
  ttlNoeudMs: 26_000,
  /** Fragments en cours : relance automatique après ce délai sans résultat. */
  ttlFragmentMs: 180_000,
  /** Nombre maximal de relances par fragment (anti-boucle). */
  générationsMax: 3,
  /** Keyframes max pour une vidéo d'essaim (1 fragment = 1 keyframe). */
  keyframesMax: 8,
  /** Keyframes par défaut (haute qualité). */
  keyframesDéfaut: 6,
  /** Taille max d'un segment de voix (caractères). */
  tailleSegment: 600,
  /** Segments de voix max par job (plafond mémoire centrale). */
  segmentsMax: 12,
  /** Charge d'un fragment en cours par nœud (un GPU = un fragment). */
  chargeMaxParNoeud: 1,
  /** Jobs actifs max (mémoire centrale honnête, VPS 2 Go). */
  jobsActifsMax: 40,
  /** Nœuds enregistrés max. */
  noeudsMax: 200,
  /** Taille max d'un fragment résultat téléversé (12 Mo). */
  tailleFragmentMax: 12 * 1024 * 1024,
  /** Taille max de l'œuvre fusionnée (25 Mo — parité webgpu-complete). */
  tailleOeuvreMax: 25 * 1024 * 1024,
  /** Purge des jobs terminés après ce délai (ms). */
  retentionJobMs: 30 * 60_000,
  /** Pas DDIM mode haute qualité. */
  stepsHaute: 26,
  /** Guidance CFG mode haute qualité. */
  guidanceHaute: 5.0,
} as const;

/** Calcule le score de capacité d'un nœud ∈ [0, 1] (fonction pure).
 *
 * Critères : mémoire GPU buffer (60 %), features f16 (15 %), réputation
 * de succès (15 %), fraîcheur du battement (10 %). Un nœud sans WebGPU
 * vaut 0 — il ne reçoit jamais de fragment.
 */
export function scoreNoeud(
  capacités: CapacitésNoeud,
  succès: number,
  dernierBattement: number,
  maintenant: number,
): number {
  if (!capacités.webgpu) return 0;
  const mémoire = Math.min(Math.max((capacités.memoireGo ?? 0) / 4, 0), 1); // 4 Go → 1.0
  const f16 = capacités.features?.some((f) => f.includes("float16") || f.includes("f16"))
    ? 1
    : 0;
  const réputation = Math.min(succès / 10, 1);
  const fraîcheur = Math.max(0, 1 - (maintenant - dernierBattement) / BORNES_ESSAIM.ttlNoeudMs);
  const brut = mémoire * 0.6 + f16 * 0.15 + réputation * 0.15 + fraîcheur * 0.1;
  return Math.round(brut * 1000) / 1000;
}

/** Découpe un texte en segments vocaux ≤ taille max (fonction pure, testée).
 * Coupe sur les frontières de phrases (. ! ? … \n) puis, si une phrase
 * dépasse la borne, sur les virgules, puis mot à mot — jamais au milieu
 * d'un mot. */
export function découperEnSegments(
  texte: string,
  tailleMax: number = BORNES_ESSAIM.tailleSegment,
): string[] {
  const propre = texte.replace(/\s+/g, " ").trim();
  if (!propre) return [];
  const phrases = propre.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [propre];
  const segments: string[] = [];
  let courant = "";
  const pousser = (s: string): void => {
    const t = s.trim();
    if (t) segments.push(t);
  };
  for (const phrase of phrases) {
    if (courant.length + phrase.length <= tailleMax) {
      courant += phrase;
      continue;
    }
    pousser(courant);
    courant = "";
    if (phrase.length <= tailleMax) {
      courant = phrase;
      continue;
    }
    // Phrase trop longue : coupe par virgules puis mot à mot.
    const morceauxVirgule = phrase.trim().split(/,\s*/);
    let sousCourant = "";
    for (const morceau of morceauxVirgule) {
      const candidat = sousCourant ? `${sousCourant}, ${morceau}` : morceau;
      if (candidat.length <= tailleMax) {
        sousCourant = candidat;
        continue;
      }
      pousser(sousCourant);
      sousCourant = "";
      if (morceau.length <= tailleMax) {
        sousCourant = morceau;
        continue;
      }
      // Même la virgule déborde : coupe mot à mot.
      const mots = morceau.split(" ");
      for (const mot of mots) {
        const c2 = sousCourant ? `${sousCourant} ${mot}` : mot;
        if (c2.length <= tailleMax) {
          sousCourant = c2;
        } else {
          pousser(sousCourant);
          sousCourant = mot.slice(0, tailleMax);
        }
      }
    }
    pousser(sousCourant);
  }
  pousser(courant);
  return segments;
}
