import "server-only";

/**
 * CHARGEUR RUNTIME DU LEXIQUE MULTIMODAL APPRIS — serveur uniquement.
 *
 * Le vocabulaire de l'analyseur sémantique est ENTRAÎNÉ HORS PRODUCTION
 * (scripts/pretrain-multimodal.ts → artefact committé dans
 * assets/neural-pretrained/multimodal-lexique-v1.json) et CHARGÉ ici au
 * premier appel — la production s'appuie sur l'artefact, elle ne
 * s'entraîne jamais en ligne (directive « entraînement hors production »).
 *
 * Échec doux : artefact absent ou illisible → lexique intégré seul,
 * avec un journal honnête (aucun vocabulaire inventé).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  construireLexique,
  type LexiqueAppris,
  type LexiqueMultimodal,
} from "./scene-spec";

export const LEXIQUE_MULTIMODAL_PRETRAIN_PATH = join(
  process.cwd(),
  "assets/neural-pretrained/multimodal-lexique-v1.json",
);

let cache: LexiqueMultimodal | null = null;
let entreesApprises = 0;

/** Charge (une fois) le lexique intégré + les entrées apprises hors production. */
export function lexiqueMultimodal(): LexiqueMultimodal {
  if (cache) return cache;
  try {
    const brut = JSON.parse(readFileSync(LEXIQUE_MULTIMODAL_PRETRAIN_PATH, "utf-8")) as LexiqueAppris;
    if (brut && brut.v === 1 && Array.isArray(brut.entries)) {
      cache = construireLexique(brut);
      entreesApprises = brut.entries.length;
      console.log(
        `[NEURAL-MULTIMODAL] Lexique scénique chargé : vocabulaire intégré + ${entreesApprises} entrée(s) apprise(s) hors production.`,
      );
      return cache;
    }
    console.warn(
      "[NEURAL-MULTIMODAL] Artefact de lexique multimodal au format inattendu — vocabulaire intégré seul.",
    );
  } catch {
    console.warn(
      "[NEURAL-MULTIMODAL] Artefact de lexique multimodal absent — vocabulaire intégré seul (relancer scripts/pretrain-multimodal.ts hors production pour l'enrichir).",
    );
  }
  cache = construireLexique(null);
  entreesApprises = 0;
  return cache;
}

/** Diagnostic honnête (exposé par les statistiques publiques). */
export function statsLexiqueMultimodal(): { entreesApprises: number } {
  lexiqueMultimodal();
  return { entreesApprises };
}
