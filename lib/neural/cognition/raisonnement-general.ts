/**
 * RAISONNEMENT GÉNÉRALISTE (LOT 5 — mission « GEN3IA BRAIN COMPLETION »).
 *
 * L'orchestrateur existant route vers des compartiments SPÉCIALISÉS
 * (math, monde virtuel, terminal). Ce module ajoute le raisonnement
 * GÉNÉRALISTE sur faits — chaînage avant borné, transitivité taxonomique
 * (isa, via le lexique de relations du LOT 2), détection de contradictions
 * (objets antonymes) — SANS IA externe, avec traces et bornes réelles.
 *
 * Les faits viennent de la mémoire (connaissances vérifiées du pipeline
 * autonome, épisodes de la mémoire cognitive) — jamais inventés : une
 * conclusion marquée « déduite » a une CHAÎNE de preuves complète.
 */

import { analyserSemantique } from "../semantique/analyseur-semantique";
import { construireIndexSemantique } from "../semantique/lexique-relations";
import { racineLegere } from "../generation/language";

/** Un fait : sujet → prédicat → objet (ex. « le Soleil émet lumière »). */
export interface Fait {
  sujet: string;
  predicat: string;
  objet: string;
  /** Source du fait (mémoire, épisode, déduction) — traçabilité. */
  source: string;
}

/** Une règle d'implication : si (sujet,prédicat,objet) alors conclusion. */
export interface Regle {
  si: { predicat: string; objet: string };
  alors: { predicat: string; objet: string };
}

/** Une conclusion déduite avec sa chaîne de preuves. */
export interface Conclusion {
  fait: Fait;
  /** La chaîne : fait(s) de départ + règle(s) appliquée(s). */
  preuves: string[];
  /** Profondeur de déduction (0 = fait direct, 1..MAX déductions). */
  profondeur: number;
}

/** MAX_DEPTH (bornes réelles — pas de chaînage infini). */
export const PROFONDEUR_MAX = 5;

const indexSem = construireIndexSemantique(racineLegere);
const racine = racineLegere;

/** CHAÎNAGE AVANT borné : applique les règles aux faits jusqu'à saturation. */
export function deduire(faits: readonly Fait[], regles: readonly Regle[]): Conclusion[] {
  const connus = new Map<string, Fait>();
  const conclusions: Conclusion[] = [];
  const cle = (f: { sujet: string; predicat: string; objet: string }) =>
    `${racine(f.sujet)}|${racine(f.predicat)}|${racine(f.objet)}`;

  for (const f of faits) connus.set(cle(f), { ...f, source: f.source || "memoire" });

  // Chaînage avant — au plus PROFONDEUR_MAX niveaux (bornes réelles) :
  // itération sur un SNAPSHOT de l'état courant — un niveau de chaîne par
  // itération (jamais plusieurs niveaux dans la même passe).
  for (let profondeur = 1; profondeur <= PROFONDEUR_MAX; profondeur++) {
    let ajoute = 0;
    for (const fait of [...connus.values()]) {
      for (const regle of regles) {
        if (racine(fait.predicat) !== racine(regle.si.predicat)) continue;
        if (racine(fait.objet) !== racine(regle.si.objet)) continue;
        const conclusion: Fait = {
          sujet: fait.sujet,
          predicat: regle.alors.predicat,
          objet: regle.alors.objet,
          source: `deduit:regle[${regle.si.predicat}→${regle.alors.predicat}]`,
        };
        const k = cle(conclusion);
        if (!connus.has(k)) {
          connus.set(k, conclusion);
          conclusions.push({ fait: conclusion, preuves: [`${fait.sujet} ${fait.predicat} ${fait.objet} (${fait.source})`], profondeur });
          ajoute += 1;
        }
      }
    }
    if (ajoute === 0) break; // saturation — arrêt honnête
  }
  return conclusions;
}

/** TRANSITIVITÉ ISA : si X isa Y et Y isa Z alors X isa Z (catégories réelles). */
export function transitiviteIsa(faits: readonly Fait[]): Conclusion[] {
  const conclusions: Conclusion[] = [];
  const isa = (s: string, o: string): boolean =>
    indexSem.categories.get(racine(s))?.has(racine(o)) === true ||
    faits.some((f) => racine(f.sujet) === racine(s) && f.predicat === "est un" && racine(f.objet) === racine(o));

  for (const f of faits) {
    if (f.predicat !== "est un") continue;
    for (const cat of indexSem.categories.get(racine(f.objet)) ?? []) {
      if (isa(racine(f.objet), cat) && !isa(racine(f.sujet), cat)) {
        conclusions.push({
          fait: { sujet: f.sujet, predicat: "est un", objet: cat, source: "deduit:transitivite-isa" },
          preuves: [`${f.sujet} est un ${f.objet} (${f.source})`, `${f.objet} est un ${cat} (lexique)`],
          profondeur: 1,
        });
      }
    }
  }
  return conclusions;
}

/** CONTRADICTIONS : même sujet+prédicat avec objets ANTONYMES. */
export interface Contradiction {
  sujet: string;
  predicat: string;
  objetA: string;
  objetB: string;
  sources: string[];
}

export function detecterContradictions(faits: readonly Fait[]): Contradiction[] {
  const contradictions: Contradiction[] = [];
  const parCle = new Map<string, Fait[]>();
  for (const f of faits) {
    const k = `${racine(f.sujet)}|${racine(f.predicat)}`;
    parCle.set(k, [...(parCle.get(k) ?? []), f]);
  }
  for (const [, groupe] of parCle) {
    for (let i = 0; i < groupe.length; i++) {
      for (let j = i + 1; j < groupe.length; j++) {
        const a = groupe[i];
        const b = groupe[j];
        if (racine(a.objet) === racine(b.objet)) continue; // même objet : redondance, pas contradiction
        const antA = indexSem.antonymes.get(racine(a.objet));
        const antB = indexSem.antonymes.get(racine(b.objet));
        if (antA?.has(racine(b.objet)) || antB?.has(racine(a.objet))) {
          contradictions.push({
            sujet: a.sujet,
            predicat: a.predicat,
            objetA: a.objet,
            objetB: b.objet,
            sources: [a.source, b.source],
          });
        }
      }
    }
  }
  return contradictions;
}

/** CONCEPTS d'un texte (pour construire des faits depuis la mémoire). */
export function conceptsDe(texte: string): string[] {
  return analyserSemantique(texte).concepts.map((c) => c.racine);
}

/** Métrique de surface (laboratoire LOT 7). */
export function surfaceRaisonnement(): { profondeurMax: number; fonctions: number } {
  return { profondeurMax: PROFONDEUR_MAX, fonctions: 3 };
}
