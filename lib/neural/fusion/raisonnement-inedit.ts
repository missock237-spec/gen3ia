/**
 * RAISONNEMENT HORS CORPUS — mission « résoudre des problèmes inédits ».
 *
 * Un problème qui ne matche NI le corpus NI les solveurs n'est plus une
 * impasse : le moteur le DÉCOMPOSE en primitives connues (calcul, texte,
 * collections…), COMPOSE un plan (chaînes de primitives portant les
 * résultats étape à étape), le VÉRIFIE, et s'il ne sait pas encore, il
 * fait une ANALOGIE avec les problèmes déjà résolus du même utilisateur
 * (mémoire permanente + résonance d'ondes) pour adapter une chaîne connue.
 * Chaque échec est HONNÊTE : « non computable localement » + le plan tenté.
 *
 * Primitives : fonctions pures déterministes testées — le plan est
 * exécutable dans n'importe quelle situation (aucune dépendance externe).
 * Ordre de matching : les collections/quantificateurs d'abord (spécifiques),
 * le calcul général en repli (opérateur ENTRE deux nombres).
 */

import { resoudreCalcul } from "@/lib/neural/solveurs/moteur-calcul";

import { extraireConcepts } from "./noeud-ondes-unifie";

/** Une primitive exécutable locale. */
export interface Primitive {
  id: string;
  /** Détecte si l'énoncé relève de cette primitive (déterministe). */
  match: (enonce: string) => boolean;
  /** Exécute l'étape portant le résultat précédent. */
  executer: (enonce: string, precedent: string | null) => ResultatPrimitive;
}

export interface ResultatPrimitive {
  ok: boolean;
  valeur: string | null;
  detail: string;
}

/** Nombres d'un énoncé — la virgule est un séparateur de liste OU une
 * décimale si elle est collée aux chiffres (9, 3 → 9 et 3 ; 3,5 → 3.5). */
function nombresDe(enonce: string): number[] {
  const brut = enonce.match(/-?\d+(?:,\d+)?(?:\.\d+)?/g) ?? [];
  return brut.map((n) => Number(n.replace(",", ".")));
}

export const PRIMITIVES: Primitive[] = [
  {
    id: "tri-croissant",
    match: (e) => /\b(tri|trie|trier|ordre\s+croissant|du\s+plus\s+petit\s+au)\b/i.test(e) && /\d/.test(e),
    executer: (e, precedent) => {
      const source = precedent ?? e;
      const nombres = nombresDe(source);
      if (nombres.length < 2) return { ok: false, valeur: null, detail: "tri exige ≥ 2 nombres" };
      const trie = [...nombres].sort((a, b) => a - b);
      return { ok: true, valeur: trie.join(" "), detail: `tri croissant : ${trie.join(" ")}` };
    },
  },
  {
    id: "maximum",
    match: (e) => /\b(maximum|max|plus\s+grand|le\s+plus\s+grand|le\s+plus\s+haut)\b/i.test(e) && /\d/.test(e),
    executer: (e, precedent) => {
      const source = precedent ?? e;
      const nombres = nombresDe(source);
      if (nombres.length < 2) return { ok: false, valeur: null, detail: "maximum exige ≥ 2 nombres" };
      const max = Math.max(...nombres);
      return { ok: true, valeur: String(max), detail: `max(${nombres.join(", ")}) = ${max}` };
    },
  },
  {
    id: "minimum",
    match: (e) => /\b(minimum|min|plus\s+petit|le\s+plus\s+bas)\b/i.test(e) && /\d/.test(e),
    executer: (e, precedent) => {
      const source = precedent ?? e;
      const nombres = nombresDe(source);
      if (nombres.length < 2) return { ok: false, valeur: null, detail: "minimum exige ≥ 2 nombres" };
      const min = Math.min(...nombres);
      return { ok: true, valeur: String(min), detail: `min(${nombres.join(", ")}) = ${min}` };
    },
  },
  {
    id: "moyenne",
    match: (e) => /\b(moyenne|en\s+moyenne)\b/i.test(e) && /\d/.test(e),
    executer: (e, precedent) => {
      const source = precedent ?? e;
      const nombres = nombresDe(source);
      if (nombres.length < 2) return { ok: false, valeur: null, detail: "moyenne exige ≥ 2 nombres" };
      const moyenne = nombres.reduce((a, b) => a + b, 0) / nombres.length;
      return { ok: true, valeur: String(Math.round(moyenne * 1e6) / 1e6), detail: `moyenne(${nombres.join(", ")}) = ${moyenne}` };
    },
  },
  {
    id: "inversion-texte",
    match: (e) => /\b(invers|renvers|à\s+l'envers|l'envers)\b/i.test(e) && /\b(de|du|la|le)\b.*\b(mot|texte|chaîne|chaine|phrase|lettre)/i.test(e),
    executer: (e) => {
      const cible = e.match(/[«"]([^»"]+)[»"]/)?.[1] ?? e.replace(/.*\b(mot|texte|chaîne|chaine|phrase)\b\s*(?:«|de)?\s*/i, "").trim();
      if (!cible) return { ok: false, valeur: null, detail: "cible d'inversion introuvable" };
      const inverse = [...cible].reverse().join("");
      return { ok: true, valeur: inverse, detail: `inverser("${cible}") = "${inverse}"` };
    },
  },
  {
    id: "calcul",
    match: (e) => /\d\s*(?:[+\-×x*÷/:^]|fois|plus|moins|divisé\s*par)\s*\d/i.test(e),
    executer: (e) => {
      const r = resoudreCalcul(e);
      if (!r) return { ok: false, valeur: null, detail: "calcul non résolu" };
      // Le solveur local répond en phrases pédagogiques — la CHAÎNE a besoin
      // de la valeur finale seule (portable par l'étape suivante).
      const finale = r.match(/Résultat final\s*:\s*(-?[\d]+(?:[.,]\d+)?)/i)?.[1] ?? r.trim();
      return { ok: true, valeur: finale, detail: `solveur calcul local → ${r.trim().slice(0, 80)}` };
    },
  },
];

/** Segmentateurs de problème composé (déterministes). */
const SEGMENTEURS = [/\s*(?:puis|ensuite|après\s*quoi|then|,\s*puis)\s*/i];

export interface EtapePlan {
  index: number;
  enonce: string;
  primitiveId: string | null;
  resultat: string | null;
  detail: string;
}

export interface PlanInedit {
  /** Le problème est-il entièrement couvert par des primitives locales ? */
  complet: boolean;
  etapes: EtapePlan[];
  /** Réponse finale portée par la chaîne (null si non computable). */
  reponseFinale: string | null;
  /** Analogie utilisée : problème résolu similaire issu de la mémoire. */
  analogie: string | null;
  /** Concepts du problème (pour la mémoire permanente). */
  concepts: string[];
}

/** Analogie : le problème résolu le plus similaire fourni par la mémoire. */
function analogieDepuisSouvenirs(conceptsProbleme: string[], souvenirs: Array<{ texte: string; score: number }>): string | null {
  if (souvenirs.length === 0 || conceptsProbleme.length === 0) return null;
  let meilleur: { texte: string; recouvrement: number } | null = null;
  for (const souvenir of souvenirs) {
    const conceptsSouvenir = extraireConcepts(souvenir.texte);
    const communs = conceptsProbleme.filter((c) => conceptsSouvenir.includes(c)).length;
    const recouvrement = communs / Math.max(1, conceptsProbleme.length);
    if (recouvrement >= 0.3 && (!meilleur || recouvrement > meilleur.recouvrement)) {
      meilleur = { texte: souvenir.texte, recouvrement };
    }
  }
  return meilleur?.texte ?? null;
}

/** Portage d'un verbe : « multiplie le résultat par 3 » portant 87 → « 87 × 3 ». */
export function porterVerbe(etape: string, precedent: string): string {
  // Les mots intermédiaires (le résultat, ce total…) sont avalés — JAMAIS
  // un nombre (le nombre est l'opérande, il reste dans l'énoncé porté).
  const mots = "(?:\\s+(?![\\d.,]+\\b)[^\\s\\d.,]+){0,3}";
  const transformees: Array<[RegExp, string]> = [
    [new RegExp(`^multiplie${mots}\\s*(?:par\\s*)?`, "i"), `${precedent} × `],
    [new RegExp(`^divise${mots}\\s*(?:par\\s*)?`, "i"), `${precedent} ÷ `],
    [new RegExp(`^(?:ajoute|additionne)${mots}\\s*`, "i"), `${precedent} + `],
    [new RegExp(`^(?:soustrais|retire)${mots}\\s*`, "i"), `${precedent} - `],
  ];
  for (const [pattern, remplacement] of transformees) {
    if (pattern.test(etape)) return etape.replace(pattern, remplacement).trim();
  }
  return etape;
}

/**
 * PLANIFICATEUR HORS CORPUS : décompose le problème en énoncés, matche les
 * primitives locales, PORTE les résultats (composition : « multiplie le
 * résultat par 3 » → « 87 × 3 »), et s'il reste des trous → analogie depuis
 * les souvenirs résolus du compte.
 */
export function planifierInedit(objectif: string, souvenirs: Array<{ texte: string; score: number }> = []): PlanInedit {
  const segments = SEGMENTEURS.flatMap((s) => objectif.split(s)).map((s) => s.trim()).filter(Boolean);
  const concepts = extraireConcepts(objectif);
  const etapes: EtapePlan[] = [];
  let precedent: string | null = null;
  let complet = segments.length > 0;

  for (let i = 0; i < segments.length; i++) {
    const enonce: string = precedent ? porterVerbe(segments[i], precedent) : segments[i];
    const primitive: Primitive | undefined = PRIMITIVES.find((p) => p.match(enonce));
    if (!primitive) {
      complet = false;
      etapes.push({ index: i, enonce, primitiveId: null, resultat: null, detail: "aucune primitive locale — analogie ou repli honnête" });
      continue;
    }
    const resultat: ResultatPrimitive = primitive.executer(enonce, precedent);
    if (!resultat.ok) {
      complet = false;
    }
    etapes.push({ index: i, enonce, primitiveId: primitive.id, resultat: resultat.valeur, detail: resultat.detail });
    if (resultat.valeur) precedent = resultat.valeur;
  }

  const analogie = complet ? null : analogieDepuisSouvenirs(concepts, souvenirs);
  const dernier = etapes[etapes.length - 1];
  const reponseFinale = complet && dernier?.resultat ? dernier.resultat : null;
  return { complet, etapes, reponseFinale, analogie, concepts };
}
