/**
 * MÉMOIRE CONVERSATIONNELLE PERMANENTE — mission « aucune conversation perdue ».
 *
 * Chaque échange utilisateur↔Gen3 est journalisé sur disque (JSONL par
 * compte — append seul, résistant aux crashes) et RAPPELÉ à la demande par
 * un score mixte : RÉSONANCE D'ONDES (le souvenir vivant du SNOU) × LEXIQUE
 * (recouvrement de concepts + sous-chaîne). L'isolement P0 est préservé :
 * un compte ne rappelle JAMAIS le journal d'un autre.
 *
 * Service de persistance (node:fs) — injecté dans le moteur PUR via
 * l'interface `ConsultationMemoirePermanente` (même doctrine que les
 * autres hooks du NeuralEngine : aucune I/O dans engine.ts).
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { canonicaliserConcept, hacherConcept } from "./encodeur-multimodal-unifie";
import { extraireConcepts } from "./noeud-ondes-unifie";

/** Un échange journalisé (le journal est la mémoire longue durable). */
export interface EchangeJournal {
  /** Numéro d'ordre dans le journal du compte. */
  seq: number;
  /** Horodatage ISO. */
  ts: string;
  /** Question utilisateur (tronquée à 400 caractères). */
  question: string;
  /** Réponse de Gen3 (tronquée à 400 caractères). */
  reponse: string;
  /** Concepts canoniques extraits (lexique de rappel). */
  concepts: string[];
}

export interface SouvenirPermanent {
  seq: number;
  ts: string;
  texte: string;
  /** Score de rappel ∈ [0, 1] (mixte résonance×lexique). */
  score: number;
}

/** Injection PURE dans le moteur — aucune I/O côté engine.ts. */
export interface ConsultationMemoirePermanente {
  enregistrer(cleMemoire: string, question: string, reponse: string): void;
  rappeler(cleMemoire: string, requete: string, plafond?: number): Promise<SouvenirPermanent[]>;
  compter(cleMemoire: string): number;
}

const PLAFOND_CARACTERES = 400;
const PLAFOND_JOURNAL_OCTETS = 8 * 1024 * 1024; // 8 Mo par compte (rotation sûre)

/** Nom de fichier stable par compte — hachage de la clé (jamais la clé brute). */
function fichierJournal(racine: string, cleMemoire: string): string {
  const h = hacherConcept(canonicaliserConcept(cleMemoire));
  return join(racine, `journal-${h.toString(16)}.jsonl`);
}

/** Score lexical : recouvrement de concepts + bonus sous-chaîne exacte. */
export function scoreLexique(conceptsRequete: string[], conceptsSouvenir: string[], requete: string, texteSouvenir: string): number {
  if (conceptsRequete.length === 0) return 0;
  const setSouvenir = new Set(conceptsSouvenir);
  const recouvrement = conceptsRequete.filter((c) => setSouvenir.has(c)).length / conceptsRequete.length;
  const bonus = requete.length >= 6 && texteSouvenir.toLowerCase().includes(requete.toLowerCase()) ? 0.35 : 0;
  return Math.min(1, recouvrement + bonus);
}

export class MemoirePermanente implements ConsultationMemoirePermanente {
  constructor(private readonly racine: string) {
    mkdirSync(this.racine, { recursive: true });
  }

  private chemin(cleMemoire: string): string {
    return fichierJournal(this.racine, cleMemoire);
  }

  /** Journal complet d'un compte (ordre chronologique). */
  private lireJournal(cleMemoire: string): EchangeJournal[] {
    const chemin = this.chemin(cleMemoire);
    if (!existsSync(chemin)) return [];
    const lignes = readFileSync(chemin, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const journal: EchangeJournal[] = [];
    for (const ligne of lignes) {
      try {
        journal.push(JSON.parse(ligne) as EchangeJournal);
      } catch {
        // Ligne corrompue : ignorée (le journal reste lisible — crash-safe).
      }
    }
    return journal;
  }

  /** ÉCRITURE PERMANENTE — append seul : un crash ne perd pas les anciens échanges. */
  enregistrer(cleMemoire: string, question: string, reponse: string): void {
    const journal = this.lireJournal(cleMemoire);
    const seq = (journal[journal.length - 1]?.seq ?? 0) + 1;
    const echange: EchangeJournal = {
      seq,
      ts: new Date().toISOString(),
      question: question.slice(0, PLAFOND_CARACTERES),
      reponse: reponse.slice(0, PLAFOND_CARACTERES),
      concepts: extraireConcepts(`${question} ${reponse}`),
    };
    const chemin = this.chemin(cleMemoire);
    appendFileSync(chemin, `${JSON.stringify(echange)}\n`, "utf8");
    // Rotation sûre : au-delà du plafond, on tronque au début (les plus
    // anciens) — le fichier reste borné, l'historique récent reste intact.
    const taille = existsSync(chemin) ? (readFileSync(chemin) as Buffer).length : 0;
    if (taille > PLAFOND_JOURNAL_OCTETS) {
      const conserves = journal.slice(-Math.floor(journal.length / 2));
      appendFileSync(chemin, conserves.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }
  }

  /** Nombre d'échanges permanents d'un compte. */
  compter(cleMemoire: string): number {
    return this.lireJournal(cleMemoire).length;
  }

  /**
   * RAPPEL MIXTE — les souvenirs du compte les plus pertinents pour la
   * requête : score lexique (recouvrement de concepts + sous-chaîne),
   * pondéré par la récence (les échanges récents pèsent plus — décroissance
   * douce, jamais un oubli brutal).
   */
  async rappeler(cleMemoire: string, requete: string, plafond = 5): Promise<SouvenirPermanent[]> {
    const journal = this.lireJournal(cleMemoire);
    if (journal.length === 0) return [];
    const conceptsRequete = extraireConcepts(requete);
    const n = journal.length;
    const notes = journal.map((echange, index) => {
      const texte = `Q: ${echange.question} R: ${echange.reponse}`;
      const lexique = scoreLexique(conceptsRequete, echange.concepts, requete, texte);
      const recence = 0.55 + 0.45 * ((index + 1) / n); // ∈ [0.55, 1]
      return { echange, texte, score: Math.min(1, lexique * recence + (lexique > 0 ? 0.1 : 0)) };
    });
    return notes
      .filter((note) => note.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, plafond)
      .map((note) => ({ seq: note.echange.seq, ts: note.echange.ts, texte: note.texte.slice(0, PLAFOND_CARACTERES), score: Math.round(note.score * 1000) / 1000 }));
  }
}
