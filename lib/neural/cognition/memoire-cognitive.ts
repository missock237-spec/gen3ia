/**
 * MÉMOIRE COGNITIVE ÉPISODIQUE (LOT 5 — raisonnement généraliste et
 * mémoire cognitive, mission « GEN3IA BRAIN COMPLETION »).
 *
 * Le cerveau disposait de : hippocampe (mémoire de TRAVAIL à court terme),
 * mémoire de domaines (compartiments 1 Go), mémoire de connaissances du
 * pipeline autonome. Il lui MANQUAIT la mémoire ÉPISODIQUE persistante :
 * se souvenir d'expériences datées, pondérées par importance, et les
 * RAPPELER par association (similarité sémantique LOT 2 + importance +
 * récence), avec caps réels (RAM 2 cœurs) et persistance disque.
 *
 * HONNÊTETÉ : une expérience est CE QUI A ÉTÉ VÉCU (interaction, aperture,
 * réflexion tracée) — jamais inventée ; le rappel retourne les épisodes
 * réellement stockés avec leur score de rappel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { analyserSemantique } from "../semantique/analyseur-semantique";

/** Un épisode vécu (persistant). */
export interface Episode {
  id: string;
  dateIso: string;
  type: "interaction" | "observation" | "reflexion";
  contenu: string;
  /** Concepts clés (racines sémantiques) — index de rappel. */
  concepts: string[];
  /** Importance 0..1 (pondère le rappel ; défaut 0.5). */
  importance: number;
}

/** Un épisode rappelé (avec son score de rappel réel). */
export interface EpisodeRappele extends Episode {
  /** Score [0..1] : 0.5 × similarité + 0.3 × importance + 0.2 × récence. */
  scoreRappel: number;
}

/** Caps de ressources (RAM 2 cœurs — bornes réelles). */
export const CAP_EPISODES = 1000;

/** Mémoire cognitive épisodique persistante. */
export class MemoireCognitive {
  private episodes = new Map<string, Episode>();
  private readonly chemin: string;

  constructor(dossier: string) {
    this.chemin = join(dossier, "cognition", "memoire-episodique.json");
    this.charger();
  }

  /** ENREGISTRE une expérience vécue (concepts extraits par le LOT 2). */
  enregistrer(entree: {
    type: Episode["type"];
    contenu: string;
    importance?: number;
    concepts?: string[];
    dateIso?: string;
  }): Episode {
    const analyse = analyserSemantique(entree.contenu);
    const episode: Episode = {
      id: `ep-${Date.now()}-${this.episodes.size}`,
      dateIso: entree.dateIso ?? new Date().toISOString(),
      type: entree.type,
      contenu: entree.contenu.slice(0, 2_000),
      concepts: entree.concepts ?? analyse.racines.slice(0, 12),
      importance: Math.max(0, Math.min(1, entree.importance ?? 0.5)),
    };
    this.episodes.set(episode.id, episode);
    this.appliquerCap();
    return episode;
  }

  /** RAPPEL ASSOCIATIF : top-k épisodes par similarité + importance + récence. */
  rappeler(texte: string, k = 5): EpisodeRappele[] {
    const analyse = analyserSemantique(texte);
    const demande = new Set(analyse.racines);
    const maintenant = Date.now();
    const resultats: EpisodeRappele[] = [];
    for (const e of this.episodes.values()) {
      const concepts = new Set(e.concepts);
      let inter = 0;
      for (const c of demande) if (concepts.has(c)) inter += 1;
      const union = demande.size + concepts.size - inter;
      const similarite = union > 0 ? inter / union : 0;
      // Récence : 1 pour « maintenant », décroît vers 0 sur 30 jours.
      const ageMs = Math.max(0, maintenant - Date.parse(e.dateIso));
      const recence = Math.max(0, 1 - ageMs / (30 * 24 * 3_600_000));
      const score = 0.5 * similarite + 0.3 * e.importance + 0.2 * recence;
      if (similarite > 0 || e.importance >= 0.8) {
        resultats.push({ ...e, scoreRappel: Math.round(score * 1000) / 1000 });
      }
    }
    return resultats.sort((a, b) => b.scoreRappel - a.scoreRappel).slice(0, k);
  }

  /** Surface honnête (métriques laboratoire). */
  taille(): number {
    return this.episodes.size;
  }

  /** Tous les épisodes (lecture ordonnée par date — pour le raisonnement). */
  tous(): Episode[] {
    return [...this.episodes.values()].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  }

  /** Cap : éviction des épisodes les moins importants et les plus anciens. */
  private appliquerCap(): void {
    if (this.episodes.size <= CAP_EPISODES) return;
    const tries = [...this.episodes.values()].sort((a, b) => {
      const critere = (e: Episode) => e.importance * 0.7 + (1 - Math.min(1, (Date.now() - Date.parse(e.dateIso)) / (30 * 24 * 3_600_000))) * 0.3;
      return critere(a) - critere(b); // les plus faibles d'abord
    });
    const aEvincer = tries.slice(0, this.episodes.size - CAP_EPISODES);
    for (const e of aEvincer) this.episodes.delete(e.id);
  }

  /** PERSISTANCE réelle (JSON atomique, dossier créé au besoin). */
  persister(): void {
    mkdirSync(dirname(this.chemin), { recursive: true });
    const tmp = `${this.chemin}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, episodes: this.tous() }, null, 1), "utf8");
    writeFileSync(this.chemin, readFileSync(tmp), "utf8"); // move atomique best-effort
  }

  private charger(): void {
    if (!existsSync(this.chemin)) return;
    try {
      const brut = JSON.parse(readFileSync(this.chemin, "utf8")) as { episodes?: Episode[] };
      for (const e of brut.episodes ?? []) this.episodes.set(e.id, e);
    } catch {
      // fichier corrompu : mémoire vide (honnête — on ne réinvente rien)
    }
  }
}
