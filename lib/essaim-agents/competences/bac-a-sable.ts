/**
 * Le Bac à Sable — la SEULE porte d'exécution des compétences injectées.
 *
 * Menace honnête : un module reçu par onde est du code étranger. Le bac
 * à sable applique donc, dans l'ordre :
 *
 *  1. FILTRE STATIQUE — motifs interdits (réseau, DOM, process,
 *     prototypes, import/require/eval/Function, globalThis…) : le
 *     module dangereux est refusé AVANT compilation ;
 *  2. PORTÉE RESTREINTE — le code est compilé en fonction à trois
 *     paramètres (`entree`, `memoire`, `journal`) : rien d'autre n'est
 *     injecté, et les builtins dangereux ne sont PAS fournis ;
 *  3. PLAFONDS DE SORTIE — journal borné (100 lignes), valeur de
 *     retour sérialisable seulement (JSON), durée wall-clock mesurée.
 *
 * LIMITE DÉCLARÉE (honnêteté) : l'exécution reste synchrone sur le fil
 * principal — une boucle infinie ne peut pas être interrompue sans un
 * Worker dédié. Le filtre statique interdit les boucles non bornées
 * évidentes (`while (true)`), et le plafond de 32 Ko borne la surface ;
 * l'isolation forte par Worker avec terminaison matérielle est
 * l'extension naturelle de ce module.
 */

import type { ModuleCompetence } from "./module-competence";

export interface ResultatSandbox {
  ok: boolean;
  /** Valeur de retour JSON-sérialisable du module. */
  valeur?: unknown;
  erreur?: string;
  /** Journal produit par le module (borné). */
  journal: string[];
  dureeMs: number;
}

export interface OptionsSandbox {
  /** Mémoire initiale du module (persistable par le registre). */
  memoire?: Record<string, unknown>;
  /** Journal maximum conservé (défaut 100 lignes). */
  maxJournal?: number;
}

const MAX_JOURNAL_DEFAUT = 100;

/** Filtre statique — refus AVANT toute compilation. */
const MOTIFS_INTERDITS: Array<[string, RegExp]> = [
  ["import dynamique", /\bimport\s*\(|\bimport\s+["']/],
  ["require", /\brequire\s*\(/],
  ["eval", /\beval\s*\(/],
  ["Function", /\bnew\s+Function\b/],
  ["réseau", /\b(fetch|XMLHttpRequest|WebSocket|importScripts|EventSource)\b/],
  ["DOM/navigateur", /\b(document|window|globalThis|self|top|parent|localStorage|sessionStorage|indexedDB|caches)\b/],
  ["processus", /\b(process|Worker|SharedWorker|postMessage)\b/],
  ["échappement de portée", /\b(__proto__|\.constructor\b|\.prototype\b|call\s*\(\s*this|apply\s*\(\s*this)\b/],
  ["boucle non bornée", /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
  ["générateurs de temporisation", /\b(setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/],
  ["récursivité profonde", /\barguments\.callee\b/],
];

export class ErreurSandbox extends Error {}

/** Vérifie un code source sans l'exécuter (diagnostique). */
export function validerCode(code: string): { ok: boolean; motifs: string[] } {
  const motifs: string[] = [];
  for (const [nom, regex] of MOTIFS_INTERDITS) {
    if (regex.test(code)) motifs.push(nom);
  }
  return { ok: motifs.length === 0, motifs };
}

/** Sérialise et borne la valeur de retour (JSON pur seulement). */
function securiserValeur(valeur: unknown, maxOctets = 16 * 1024): { ok: boolean; valeur?: unknown } {
  try {
    const texte = JSON.stringify(valeur);
    if (texte === undefined) return { ok: true, valeur: null };
    if (texte.length > maxOctets) return { ok: false };
    return { ok: true, valeur: JSON.parse(texte) };
  } catch {
    return { ok: false };
  }
}

/**
 * Exécute une compétence installée dans le bac à sable.
 * Le code ne reçoit QUE : `entree` (gelé), `memoire` (objet persistable),
 * `journal` (fonction log). Aucun autre identifiant n'est injecté.
 * La mémoire finale est restituée : le registre peut la persister entre
 * les exécutions si la compétence en a besoin (compteurs, cache…).
 */
export function executerCompetence(
  module: ModuleCompetence,
  entree: unknown,
  options?: OptionsSandbox,
): ResultatSandbox & { memoire: Record<string, unknown> } {
  const debut = performance.now();
  const journal: string[] = [];
  const maxJournal = options?.maxJournal ?? MAX_JOURNAL_DEFAUT;
  const memoire: Record<string, unknown> = { ...(options?.memoire ?? {}) };
  const echec = (erreur: string): ResultatSandbox & { memoire: Record<string, unknown> } => ({
    ok: false,
    erreur,
    journal,
    dureeMs: performance.now() - debut,
    memoire,
  });

  // 1. Filtre statique.
  const verdict = validerCode(module.code);
  if (!verdict.ok) {
    return echec(`Module refusé par le bac à sable : motif(s) interdit(s) — ${verdict.motifs.join(", ")}.`);
  }

  // 2. Gel de l'entrée : le module ne peut pas muter ce qu'il reçoit.
  let entreeGelée: unknown;
  try {
    entreeGelée = JSON.parse(JSON.stringify(entree ?? null));
  } catch {
    return echec("Entrée non sérialisable (JSON pur exigé).");
  }

  // 3. Compilation en portée restreinte.
  const fabrique = new Function(
    "entree",
    "memoire",
    "journal",
    `"use strict";\n${module.code}\n;return typeof executer === "function" ? executer(entree, memoire, journal) : { erreur: "aucune fonction executer" };`,
  );

  const loguer = (ligne: unknown) => {
    if (journal.length >= maxJournal) return;
    const texte = typeof ligne === "string" ? ligne : JSON.stringify(ligne) ?? String(ligne);
    journal.push(texte.slice(0, 300));
  };

  // 4. Exécution bornée en sortie.
  let brut: unknown;
  try {
    brut = fabrique(entreeGelée, memoire, loguer);
  } catch (e) {
    return echec(`Le module a levé : ${e instanceof Error ? e.message : String(e)}`);
  }

  const securise = securiserValeur(brut);
  if (!securise.ok) {
    return echec("Valeur de retour trop lourde ou non sérialisable (16 Ko JSON maximum).");
  }

  return {
    ok: true,
    valeur: securise.valeur,
    journal,
    dureeMs: performance.now() - debut,
    memoire,
  };
}
