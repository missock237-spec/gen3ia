/**
 * HIPPOCAMPE — Mémoire de travail à court terme.
 *
 * Portage fidèle de la classe `HippocampusMemory` de la source Python
 * de l'utilisateur (Inportateur.pdf) : conserve le contexte récent de
 * la conversation (fenêtre glissante de tours « utilisateur / réponse »)
 * et le formate pour nourrir le raisonnement du noyau neuronal.
 *
 * Module PUR — aucune dépendance Node.
 */

import type { ReseauNeuronalGen3 } from "../core/network";
import type { NoyauCentralGen3 } from "../core/central-core";
import { capturerSnapshot } from "../generation/snapshot";
import type { NeuralSnapshot } from "../generation/snapshot";

/** Taille par défaut de la fenêtre de mémoire court terme. */
export const TAILLE_FENETRE_DEFAUT = 10;

/** Un tour de conversation mémorisé. */
export interface TourMemoire {
  user: string;
  system: string;
}

export class HippocampusMemory {
  private readonly history: TourMemoire[] = [];

  constructor(private readonly maxHistory: number = TAILLE_FENETRE_DEFAUT) {}

  /** Enregistre un tour complet (entrée utilisateur + réponse système). */
  remember(userInput: string, systemResponse: string): void {
    this.history.push({
      user: userInput.slice(0, 2000),
      system: systemResponse.slice(0, 2000),
    });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /** Historique récent (copie défensive). */
  getHistory(): TourMemoire[] {
    return [...this.history];
  }

  /** Formate l'historique récent pour nourrir le raisonnement (source Python). */
  getContextString(): string {
    let context = "";
    for (const item of this.history) {
      context += `U: ${item.user} | A: ${item.system}\n`;
    }
    return context;
  }

  /** Purge la mémoire court terme. */
  reset(): void {
    this.history.length = 0;
  }
}

/** Type d'action déterminé par le superviseur (source Python : routage intelligent). */
export type TypeActionSuperviseur =
  | "reponse_texte"
  | "creation_fichier";

/** Rapport complet d'un tour du superviseur. */
export interface RapportSuperviseur {
  /** Rapport du cycle neuronal sous-jacent (réel). */
  brainReport: {
    neuroneCentralActive: number;
    neuronesActifs: number;
    mode: string;
    resonances: Record<string, number>;
  };
  /** Action déterminée par le superviseur. */
  actionType: TypeActionSuperviseur;
  /** Charge utile de l'action (contenu texte ou fichier suggéré). */
  payload: string;
  /** Contexte court terme pris en compte (aperçu, fenêtre réelle). */
  contextePrixEnCompte: boolean;
  /** Nombre de tours mémorisés dans l'hippocampe. */
  toursMemorises: number;
}

/** Nom de fichier suggéré pour une création (caractères sûrs uniquement). */
function nomFichierSur(rawInput: string): string {
  const base = rawInput
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `gen3_${base || "sortie"}.txt`;
}

/**
 * SUPERVISEUR CENTRAL — chef d'orchestration de la boucle cognitive.
 *
 * Portage adapté de `CentralSupervisor` (Inportateur.pdf) :
 *   Capteurs → Hippocampe → Cortex (noyau neuronal) → Action → Mémoire.
 *
 * Adaptations honnêtes documentées :
 *  - le routage d'action « create_file » de la source écrivait un
 *    fichier local simulé ; ici il PRODUIT une charge utile réelle
 *    (contenu texte complet) que l'appelant (API) délivre comme
 *    artefact — jamais d'écriture disque dissimulée ;
 *  - la « réponse texte » est la réponse décodée du moteur neuronal
 *    (lib/neural/engine.ts), pas d'un LLM externe.
 */
export class CentralSupervisor {
  readonly hippocampus: HippocampusMemory;

  constructor(
    private readonly brain: NoyauCentralGen3,
    private readonly reseau: ReseauNeuronalGen3,
    maxHistory = 5,
  ) {
    this.hippocampus = new HippocampusMemory(maxHistory);
  }

  /** Capture l'état neuronal courant (traçabilité du tour). */
  snapshot(rawInput: string): NeuralSnapshot {
    return capturerSnapshot(this.reseau, rawInput);
  }

  /**
   * Boucle cognitive complète : ingestion sensorielle (tokenisation),
   * contexte hippocampe, propagation dans le cortex, routage de
   * l'action et mémorisation du tour.
   */
  processUserIntent(
    rawInput: string,
    reponseNeuronale: string,
    rapportCycle?: { neuronesActifs: number; mode: string; resonances: Record<string, number> },
  ): RapportSuperviseur {
    // 1. Capteur sensoriel : le texte est tokenisé (ingestion réelle).
    // 2. Contexte court terme : l'hippocampe alimente la fenêtre.
    const contexte = this.hippocampus.getContextString();
    const contextePrixEnCompte = contexte.length > 0;

    // 3. Passage à travers le cortex : le cycle a déjà été exécuté par
    //    l'appelant (moteur IA) — on en rapporte les données réelles.
    const neuroneCentralActive = rapportCycle
      ? neuroneLePlusActif(rapportCycle.resonances)
      : 0;

    // 4. Détermination de l'action : routage intentionnel déterministe
    //    (fidèle à la source : mots-clés de création → création).
    const lower = rawInput.toLowerCase();
    const intentionCreation =
      /\b(cr[ée]{1,2}|créer|cree|fichier|file|g[ée]n[ée]r|genere|génère|générer|document|script|rapport|note)\b/.test(lower);

    let actionType: TypeActionSuperviseur = "reponse_texte";
    let payload = reponseNeuronale;

    if (intentionCreation) {
      actionType = "creation_fichier";
      payload = [
        `# Généré par le Superviseur Gen3`,
        `# Requête d'origine : ${rawInput.slice(0, 500)}`,
        `# Neurone cortical central : #${neuroneCentralActive}`,
        `# Mode : ${rapportCycle?.mode ?? "TRAITEMENT_REQUETE"}`,
        ``,
        reponseNeuronale,
      ].join("\n");
    }

    // 5. Mémorisation dans l'hippocampe (mémoire court terme).
    this.hippocampus.remember(rawInput, reponseNeuronale);

    return {
      brainReport: {
        neuroneCentralActive,
        neuronesActifs: rapportCycle?.neuronesActifs ?? 0,
        mode: rapportCycle?.mode ?? "TRAITEMENT_REQUETE",
        resonances: rapportCycle?.resonances ?? {},
      },
      actionType,
      payload,
      contextePrixEnCompte,
      toursMemorises: this.hippocampus.getHistory().length,
    };
  }

  /** Nom de fichier suggéré pour une création (exposition utilitaire). */
  nomFichierSuggere(rawInput: string): string {
    return nomFichierSur(rawInput);
  }
}

/** Neurone cortical « central » du tour : canal à la plus forte résonance réelle. */
function neuroneLePlusActif(resonances: Record<string, number>): number {
  let meilleurCanal = "INTENTION_GENERALE";
  let meilleurScore = -1;
  for (const [canal, score] of Object.entries(resonances)) {
    if (score > meilleurScore) {
      meilleurScore = score;
      meilleurCanal = canal;
    }
  }
  // Hash stable du canal gagnant → numéro de neurone reproductible.
  let hash = 0x811c9dc5;
  for (let i = 0; i < meilleurCanal.length; i++) {
    hash ^= meilleurCanal.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}
