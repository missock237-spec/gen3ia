/**
 * CORPUS DÉVELOPPEMENT WEB — SOUS-THÈMES JAVASCRIPT MODERNE + TYPESCRIPT
 * (it.150).
 *
 * JavaScript ES2023+ (méthodes non mutantes findLast/toSorted/toReversed/
 * with, at, flatMap), async/await et promesses, modules ESM, closures et
 * event loop ; TypeScript : types, unions, narrowing, génériques, types
 * utilitaires, satisfies.
 *
 * Deux sources honnêtes : paires RÉDIGÉES (cœur de qualité) + unités
 * déterministes du générateur lib/gen3/generateur-dev-web-it150.ts.
 * Module PUR — aucune dépendance Node.
 */

import type { PaireLangage } from "./corpus";
import {
  unitesFamilleDevWeb,
  type UniteDevWeb,
} from "../../gen3/generateur-dev-web-it150";

const THEME = "developpement-web:js-ts";

const ECRIRE = (motif: string, reponse: string): PaireLangage => ({
  motif,
  reponse,
  theme: THEME,
});

export const CORPUS_DEV_WEB_JS_TS_ECRIT: readonly PaireLangage[] = [
  // ─── JavaScript moderne ─────────────────────────────────────────────────
  ECRIRE(
    "Comment fonctionne async/await en JavaScript ?",
    "async marque une fonction qui renvoie TOUJOURS une promesse ; await suspend cette fonction jusqu'au résultat — sans BLOQUER le thread (l'event loop continue de servir les autres tâches). Les erreurs se rattrapent avec try/catch autour du await. Séquentiel : un await par ligne ; parallèle : lancer les promesses d'abord puis Promise.all.",
  ),
  ECRIRE(
    "await bloque-t-il le thread principal ?",
    "Non : await rend la main à l'event loop pendant l'attente — le navigateur continue de peindre et de répondre aux événements. Seule l'EXÉCUTION de la fonction async reste suspendue. Un travail CPU lourd, lui, bloque vraiment : le découper (setTimeout, Web Worker, scheduler.yield).",
  ),
  ECRIRE(
    "Comment gérer les erreurs dans une fonction async ?",
    "try/catch autour des await (l'erreur de la promesse devient une exception). Sans catch : rejection non gérée (unhandledrejection). Pour ignorer proprement : await plus .catch(() => {}) ou Promise.allSettled quand chaque issue compte. Un return d'erreur dans un catch async renvoie une promesse rejetée au CALLANT suivant.",
  ),
  ECRIRE(
    "Promise.all vs Promise.allSettled : lequel quand ?",
    "all : TOUT doit réussir — échoue dès la première erreur (fail-fast, utile quand le résultat n'a de sens que complet). allSettled : attend toutes les issues, renvoie { status, value/reason } pour chacune — ne rejette jamais (utile pour N appels indépendants dont on veut chaque sort). race : première issue (y compris échec) ; any : premier succès.",
  ),
  ECRIRE(
    "Comment paralléliser des appels réseau en JavaScript ?",
    "Construire d'abord TOUTES les promesses (const p = urls.map(u => fetch(u))) puis await Promise.all(p). Un await dans une boucle for est SÉQUENTIEL (chaque tour attend le précédent) — la différence de latence est le facteur N.",
  ),
  ECRIRE(
    "Qu'est-ce qu'une closure en JavaScript ?",
    "Une fonction qui se souvient de la portée où elle a été CRÉÉE : le compteur d'une fonction fabrique, les handlers qui captent des variables du useEffect. Cas d'usage : encapsulation, fonctions spécialisées, mémoïsation. Piège : capturer une variable de boucle (let par tour = OK, var partagée = bug) et les closures obsolètes dans les hooks.",
  ),
  ECRIRE(
    "Comment fonctionne l'event loop avec les microtasks ?",
    "Un tour : pile d'exécution vide → vider TOUTE la file des MICROTASKS (promesses résolues, queueMicrotask) → éventuel rendu → MACROTASK suivante (setTimeout, événements, I/O). D'où : un .then passe AVANT un setTimeout(0). Ordre prévisible : synchrone > microtasks > macrotasks.",
  ),
  ECRIRE(
    "Que fait this dans une fonction fléchée ?",
    "La flèche ne crée PAS de this : elle capture celui de la portée englobante (lexical). Fini le bind() pour les callbacks de classe ; inversement, une flèche en méthode ne peut pas être « détachée » avec son propre this. Pour une méthode d'objet qui utilise this : fonction normale ; pour un callback : flèche.",
  ),
  ECRIRE(
    "Quels sont les ajouts ES2023 utiles sur les tableaux ?",
    "Les NON-MUTANTS : toSorted (tri → nouveau tableau), toReversed (inverse → nouveau), toSpliced (splice → nouveau), with (remplace un index → nouveau) — l'immutabilité sans copie manuelle. Plus findLast/findLastIndex (dernier élément correspondant) et at() (index négatif : arr.at(-1)).",
  ),
  ECRIRE(
    "Quelle différence entre slice et splice ?",
    "slice(début, fin) COPIE une tranche sans toucher l'original (fin exclu, index négatifs acceptés). splice(début, nb, ...ajouts) MODIFIE en place (supprime/insère) et renvoie les éléments retirés. Les ES2023 toSpliced/with donnent des versions non mutantes de splice/avec.",
  ),
  ECRIRE(
    "Comment fonctionnent les modules ESM en JavaScript ?",
    "Un fichier = un module ; export nommé (plusieurs par fichier) ou export default (un seul) ; import avec le chemin relatif ou le nom de paquet. Les imports sont statiques et hoistés — ce qui permet le tree shaking ; import() dynamique renvoie une promesse (code splitting). import.meta expose l'URL du module.",
  ),
  ECRIRE(
    "Comment cloner profondément un objet en JavaScript ?",
    "structuredClone(valeur) — natif, gère Map/Set/Date/dates imbriquées, mais PAS les fonctions ni le DOM. JSON.parse(JSON.stringify(x)) perd undefined, Dates (→ chaînes), Map/Set et casse les NaN — bon seulement pour du JSON pur. Les librairies (immer, lodash) restent utiles pour des cas spéciaux.",
  ),
  ECRIRE(
    "Comment déstructurer proprement en JavaScript ?",
    "const { a, b = défaut, ...reste } = objet ; const [premier, , troisieme] = tableau. Paramètres de fonction : function f({ nom, age = 0 } = {}). Renommage : const { a: alias }. Réduits les erreurs d'index et documentent les entrées attendues.",
  ),
  ECRIRE(
    "Optional chaining et nullish coalescing : comment les utiliser ?",
    "obj?.a?.b court-circuite (undefined dès que maillon absent — n'appelle pas la suite) ; arr?.[i] ; fn?.() n'appelle que si fn existe. ?? renvoie la valeur de DROITE seulement pour null/undefined (0 et \"\" restent) — contrairement à || qui écrase les falsy. Les deux ensemble : const port = config?.port ?? 443.",
  ),
  ECRIRE(
    "Quand utiliser Map plutôt qu'un objet ?",
    "Map : clés de N'IMPORTE quel type, ordre d'insertion garanti, taille (size) directe, itération propre, performance stable sous ajouts/suppressions fréquents. Objet : clés chaîne/symbole, syntaxe littérale, structure fixe (et JSON sérialisable). Set pour l'UNICITÉ (has en O(1), dédoublonnage [...new Set(list)]).",
  ),
  ECRIRE(
    "Comment éviter les fuites de mémoire en JavaScript navigateur ?",
    "Couper ce qui retient : removeEventListener (ou { once: true }), clearInterval/timeout, observer.disconnect() (IntersectionObserver, ResizeObserver), refs DOM supprimées dans un Map module-scope, timers qui capturent des gros objets. Indice : profiler heap, snapshots croissants entre deux captures.",
  ),
  ECRIRE(
    "Comment limiter le débit d'un événement rapide (debounce vs throttle) ?",
    "debounce : attendre le SILENCE (ex. recherche : n'appeler qu'après 300 ms sans frappe). throttle : au plus une exécution par fenêtre (ex. scroll : max 1 par 100 ms). Implémentation : timer réarmé (debounce) ou flag + horodatage (throttle) — ou les hooks maison useDebouncedValue/useThrottledCallback.",
  ),
  ECRIRE(
    "Comment manipuler proprement le DOM en JS moderne ?",
    "querySelector/querySelectorAll (iterator, pas d'array forcée : [...nodeList]), createElement/append, closest() pour remonter, dataset pour les data-*, textContent plutôt que innerHTML (anti-XSS), délégation d'événement sur un conteneur plutôt qu'un listener par enfant. Créer d'abord, monter ensuite (un reflow).",
  ),
  // ─── TypeScript ─────────────────────────────────────────────────────────
  ECRIRE(
    "Que sont les génériques TypeScript et à quoi servent-ils ?",
    "Un paramètre de TYPE : function premier<T>(l: T[]): T | undefined — la fonction garde le type EXACT de son entrée au lieu de le perdre en any. Réutilisabilité type-safe : conteneurs, helpers de requête, hooks. Contrainte : <T extends { id: string }> exige id ; défaut : <T = string> ; l'INFÉRENCE fait que l'appelant n'écrit presque jamais T.",
  ),
  ECRIRE(
    "Comment contraindre un générique TypeScript ?",
    "<T extends Contrainte> : T doit satisfaire la contrainte — <T extends { id: string }>(l: T[]) puis t.id compile. Contrainte clé : <K extends keyof T> pour un getter type-safe (function get<T, K extends keyof T>(o: T, c: K): T[K]). La contrainte documente ET active l'accès aux membres.",
  ),
  ECRIRE(
    "interface vs type en TypeScript : que choisir ?",
    "Les deux définissent des formes d'objet ; interface : extensible (declaration merging, implements), messages d'erreur clairs ; type : unions, tuples, types conditionnels, mapped types — tout ce qu'une interface ne peut pas faire. Convention courante : interface pour les objets publics, type pour les unions/utilitaires.",
  ),
  ECRIRE(
    "Comment affiner un type union en TypeScript (narrowing) ?",
    "typeof x === \"string\" pour les primitives ; in pour les propriétés discriminantes ; instanceof pour les classes ; prédicat x is Type dans un booléen pour les gardes personnalisées. Les unions DISCRIMINÉES ({ kind: \"cercle\" } | { kind: \"carré\" }) + switch sur kind = exhaustivité vérifiée (never attrape le cas oublié).",
  ),
  ECRIRE(
    "unknown vs any vs never : quand ?",
    "unknown : valeur de type inconnu mais UTILISATION interdite sans affinage — le any honnête (entrées API, JSON.parse). any : désactive la vérification — à bannir du code de production. never : l'impossible — fin d'un switch exhaustif, fonction qui lance toujours ; le compilateur s'en sert pour prouver l'exhaustivité.",
  ),
  ECRIRE(
    "À quoi sert readonly en TypeScript ?",
    "Interdit la MUTATION à la compilation (la valeur runtime reste modifiable) : champs readonly, readonly T[] (pas de push), Readonly<T> (tous les champs). Contrat d'immutabilité : props React, état applicatif, données partagées. Attention : readonly ne s'assigne pas à un tableau mutable (assignabilité stricte).",
  ),
  ECRIRE(
    "Qu'est-ce que satisfies en TypeScript ?",
    "valide une valeur contre un type SANS élargir son inféré : const theme = { rouge: \"ff0000\", bleu: \"0000ff\" } satisfies Record<string, string> — les erreurs sont détectées ET theme.rouge reste \"ff0000\" (littéral), pas string. Évite l'annotation + assertion qui perd l'information.",
  ),
  ECRIRE(
    "Comment typer une fonction en TypeScript ?",
    "type Comparateur = (a: number, b: number) => number ; paramètres nommés : (opts: { cache?: boolean }) => Promise<Donnees>. Surcharge par union d'appels ou overload signatures. void pour l'absence de retour utile ; génériques pour préserver les types d'entrée (map<T, U>).",
  ),
  ECRIRE(
    "Comment typer les données d'une API en TypeScript ?",
    "Définir les interfaces de réponse (DiscriminatedUnion pour les variantes) ; les entrées externes sont UNKNOWN : valider au bord (gardes is, schéma zod/valibot, ou parseur maison) puis le type prouve le reste. Jamais de any sur la frontière réseau — c'est là que les mauvaises données arrivent.",
  ),
  ECRIRE(
    "Comment rendre un helper de config type-safe avec keyof ?",
    "function lire<T, K extends keyof T>(config: T, clé: K): T[K] — le compilateur accepte seulement les clés réelles et renvoie le BON type par clé. Combiné à keyof typeof CONFIG, toute faute de frappe devient une erreur de compilation, pas un undefined en production.",
  ),
  ECRIRE(
    "Quand utiliser as const et pourquoi ?",
    "as const fige : littéraux exacts (\"erreur\" au lieu de string), tableaux readonly tuples, objets profondément readonly. Utile pour les enums maison (const STATUTS = { ok: \"ok\", ko: \"ko\" } as const) et les tableaux de littéraux → types d'union dérivés (typeof STATUTS[keyof typeof STATUTS]).",
  ),
];

function versPaire(u: UniteDevWeb): PaireLangage {
  return { motif: u.motif, reponse: u.reponse, theme: u.theme };
}

const FAMILLES_JS_TS = [
  "methodes-tableau",
  "promesses-js",
  "modules-js",
  "types-ts",
  "utility-types-ts",
] as const;

function genereFamilles(): readonly PaireLangage[] {
  const sorties: PaireLangage[] = [];
  for (const fam of FAMILLES_JS_TS) {
    for (const u of unitesFamilleDevWeb(fam, 10_000)) {
      sorties.push(versPaire(u));
    }
  }
  return sorties;
}

export const CORPUS_DEV_WEB_JS_TS_GENERE: readonly PaireLangage[] =
  genereFamilles();

export const CORPUS_DEV_WEB_JS_TS: readonly PaireLangage[] = [
  ...CORPUS_DEV_WEB_JS_TS_ECRIT,
  ...CORPUS_DEV_WEB_JS_TS_GENERE,
];

export const TAILLE_CORPUS_DEV_WEB_JS_TS = CORPUS_DEV_WEB_JS_TS.length;
