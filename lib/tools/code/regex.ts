import "server-only";

import { z } from "zod";

import type { ToolDefinition } from "../types";

/**
 * OUTIL `dev.regex` — testeur d'expressions régulières avec garde ReDoS.
 *
 * Donne pour chaque chaîne testée les correspondances réelles avec leurs
 * groupes (numérotés et nommés) et leurs positions. Sécurité anti-ReDoS à
 * trois niveaux, HONNÊTE sur ses limites :
 *  1. bornes d'entrée dures (pattern 2 000 caractères, chaîne 10 000,
 *     100 chaînes, total 100 000 caractères) ;
 *  2. avis heuristique sur les motifs à quantificateurs imbriqués
 *     (/(a+)+/ …) — un avis, PAS une garantie d'absence de ReDoS ;
 *  3. exécution DÉCOUPÉE en fenêtres avec chevauchement + échéance murale
 *     (deadlineMs) vérifiée entre fenêtres et entre correspondances : les
 *     fenêtres bornent la portée de chaque appel ; un appel unique ne peut
 *     PAS être interrompu (limite intrinsèque de RegExp) — le résultat
 *     partiel est signalé (`partiel: true`).
 */

const PATTERN_MAX_CARACTERES = 2_000;
const CHAINE_MAX_CARACTERES = 10_000;
const CHAINES_MAX = 100;
const TOTAL_MAX_CARACTERES = 100_000;
const TAILLE_FENETRE = 1_000;
const CHEVAUCHEMENT = 200;
const CORRESPONDANCES_MAX_PAR_CHAINE = 1_000;
const CORRESPONDANCES_MAX_TOTAL = 5_000;
const DELAI_PAR_DEFAUT_MS = 1_000;

const EntreeDevRegex = z.object({
  pattern: z.string().min(1).max(PATTERN_MAX_CARACTERES),
  drapeaux: z
    .string()
    .max(8)
    .regex(/^[dgimsuvy]*$/, "drapeaux invalides (autorisés : d g i m s u v y)")
    .refine((d) => new Set(d).size === d.length, "drapeaux en double")
    .optional(),
  chaines: z.array(z.string().max(CHAINE_MAX_CARACTERES)).min(1).max(CHAINES_MAX),
  deadlineMs: z.number().int().min(0).max(2_000).default(DELAI_PAR_DEFAUT_MS),
});

export interface Correspondance {
  valeur: string;
  index: number;
  /** Groupes de capture numérotés (null si non participant). */
  groupes: Array<string | null>;
  /** Groupes nommés, présents uniquement si le motif en déclare. */
  groupesNommes?: Record<string, string>;
}

export interface ResultatChaine {
  index: number;
  chaine: string;
  correspondances: Correspondance[];
  nombre: number;
  /** Plafond de correspondances atteint pour cette chaîne. */
  tronque: boolean;
  /** Échéance atteinte avant la fin du traitement de cette chaîne. */
  partiel: boolean;
}

export interface SortieDevRegex {
  succes: boolean;
  erreur?: string;
  pattern: string;
  drapeaux: string;
  /** Heuristique : quantificateurs imbriqués détectés (avis, pas une garantie). */
  avisReDoS: boolean;
  avis: string[];
  resultats: ResultatChaine[];
  totalCorrespondances: number;
  /** Échéance atteinte : résultats incomplets (honnêteté). */
  partiel: boolean;
  /** Plafond global de correspondances atteint. */
  tronque: boolean;
  deadlineMs: number;
}

/** Heuristique anti-ReDoS : groupe à quantificateur imbriqué (« (a+)+ », « (a*)+ », « (x{2,5}){2,} »…). */
const REGEX_QUANT_IMBRIQUE =
  /\((?:[^()\\]|\\.)*[+*]\)\s*[+*{]|\((?:[^()\\]|\\.)*\{\d+(?:,\d*)?\}\)\s*[+*{]/;

interface CorrespondanceBrute {
  valeur: string;
  index: number;
  longueur: number;
  groupes: Array<string | null>;
  groupesNommes?: Record<string, string>;
}

/** Collecte les correspondances d'une fenêtre (slice) avec les positions absolues. */
function collecterFenetre(regex: RegExp, fenetre: string, decalage: number, echeance: number, plafondRestant: number): { correspondances: CorrespondanceBrute[]; tronque: boolean; echu: boolean } {
  const correspondances: CorrespondanceBrute[] = [];
  const tronque = false;
  regex.lastIndex = 0;
  let garde = 0;
  for (;;) {
    if (Date.now() >= echeance) return { correspondances, tronque, echu: true };
    garde += 1;
    if (garde > CORRESPONDANCES_MAX_PAR_CHAINE * 2) return { correspondances, tronque: true, echu: false };
    const m = regex.exec(fenetre);
    if (!m) break;
    correspondances.push({
      valeur: m[0],
      index: m.index + decalage,
      longueur: m[0].length,
      groupes: m.slice(1).map((g) => (g === undefined ? null : g)),
      ...(m.groups && Object.keys(m.groups).length > 0 ? { groupesNommes: { ...m.groups } } : {}),
    });
    if (correspondances.length >= plafondRestant) return { correspondances, tronque: true, echu: false };
    if (m[0].length === 0) {
      regex.lastIndex += 1;
      if (regex.lastIndex > fenetre.length) break;
    }
  }
  return { correspondances, tronque: false, echu: false };
}

/** Recherche dans une chaîne : fenêtres chevauchantes + échéance + déduplication. */
function rechercherDansChaine(regex: RegExp, chaine: string, echeance: number, plafondTotalRestant: number): { correspondances: Correspondance[]; tronque: boolean; partiel: boolean; decoupee: boolean } {
  if (regex.flags.includes("y")) {
    // Drapeau « sticky » : sémantique position fixe — exécution entière (une seule correspondance possible).
    regex.lastIndex = 0;
    const { correspondances, tronque, echu } = collecterFenetre(regex, chaine, 0, echeance, plafondTotalRestant);
    return {
      correspondances: correspondances.map(({ valeur, index, groupes, groupesNommes }) => ({ valeur, index, groupes, ...(groupesNommes ? { groupesNommes } : {}) })),
      tronque,
      partiel: echu,
      decoupee: false,
    };
  }

  const resultats: Correspondance[] = [];
  const dejaVus = new Set<number>();
  let plafondRestant = plafondTotalRestant;
  let tronque = false;
  let partiel = false;
  const decoupee = chaine.length > TAILLE_FENETRE + CHEVAUCHEMENT;

  if (!decoupee) {
    regex.lastIndex = 0;
    const { correspondances, tronque: coupe, echu } = collecterFenetre(regex, chaine, 0, echeance, plafondRestant);
    for (const c of correspondances) {
      resultats.push({ valeur: c.valeur, index: c.index, groupes: c.groupes, ...(c.groupesNommes ? { groupesNommes: c.groupesNommes } : {}) });
    }
    return { correspondances: resultats, tronque: tronque || coupe, partiel: echu, decoupee };
  }

  let depart = 0;
  let finPrecedente = -1;
  while (depart < chaine.length) {
    if (Date.now() >= echeance) {
      partiel = true;
      break;
    }
    const fin = Math.min(chaine.length, depart + TAILLE_FENETRE + CHEVAUCHEMENT);
    const fenetre = chaine.slice(depart, fin);
    regex.lastIndex = 0;
    for (;;) {
      if (Date.now() >= echeance) {
        partiel = true;
        break;
      }
      const m = regex.exec(fenetre);
      if (!m) break;
      const indexAbsolu = m.index + depart;
      const longueur = m[0].length;
      const couvertPrecedemment = finPrecedente >= 0 && indexAbsolu < finPrecedente && indexAbsolu + longueur <= finPrecedente;
      if (!couvertPrecedemment && !dejaVus.has(indexAbsolu)) {
        dejaVus.add(indexAbsolu);
        resultats.push({
          valeur: m[0],
          index: indexAbsolu,
          groupes: m.slice(1).map((g) => (g === undefined ? null : g)),
          ...(m.groups && Object.keys(m.groups).length > 0 ? { groupesNommes: { ...m.groups } } : {}),
        });
        plafondRestant -= 1;
        if (resultats.length >= CORRESPONDANCES_MAX_PAR_CHAINE || plafondRestant <= 0) {
          tronque = true;
          break;
        }
      }
      if (longueur === 0) {
        regex.lastIndex += 1;
        if (regex.lastIndex > fenetre.length) break;
      }
    }
    if (partiel || tronque) break;
    finPrecedente = fin;
    depart = fin - CHEVAUCHEMENT;
    if (fin === chaine.length) break;
  }
  return { correspondances: resultats, tronque, partiel, decoupee };
}

export const outilDevRegex: ToolDefinition<z.infer<typeof EntreeDevRegex>, SortieDevRegex> = {
  id: "dev.regex",
  name: "dev.regex",
  description:
    "Testeur d'expressions régulières : pour chaque chaîne testée, renvoie les correspondances réelles avec index, groupes de capture (numérotés et nommés) — utile pour valider un pattern avant de l'appliquer en production. " +
    "Input : { pattern: \"…\", drapeaux?: \"gimsuy…\", chaines: [\"…\"], deadlineMs?: 0–2000 (défaut 1000) }. " +
    "Sécurité ReDoS : bornes dures d'entrée (pattern 2 000, chaîne 10 000, total 100 000 caractères), exécution découpage par fenêtres avec chevauchement + échéance murale (partiel=true si atteinte), avis heuristique sur les quantificateurs imbriqués — un avis n'est PAS une garantie d'absence de ReDoS, un appel de fenêtre unique ne peut pas être interrompu.",
  category: "code",
  risk: "low",
  inputSchema: EntreeDevRegex,
  async execute(input) {
    const debut = Date.now();
    const echeance = debut + input.deadlineMs;
    const drapeaux = input.drapeaux ?? "";
    const avis: string[] = [];
    const totalCaracteres = input.chaines.reduce((somme, chaine) => somme + chaine.length, 0);

    const base: SortieDevRegex = {
      succes: false,
      pattern: input.pattern,
      drapeaux,
      avisReDoS: false,
      avis,
      resultats: [],
      totalCorrespondances: 0,
      partiel: false,
      tronque: false,
      deadlineMs: input.deadlineMs,
    };

    if (totalCaracteres > TOTAL_MAX_CARACTERES) {
      return {
        ...base,
        erreur: `Entrées trop volumineuses : ${totalCaracteres} caractères cumulés (maximum ${TOTAL_MAX_CARACTERES}) — réduit le nombre ou la taille des chaînes.`,
      };
    }

    const avisReDoS = REGEX_QUANT_IMBRIQUE.test(input.pattern);

    let regex: RegExp;
    try {
      const drapeauxInternes = drapeaux.includes("y") ? drapeaux : `${drapeaux}g`;
      regex = new RegExp(input.pattern, drapeauxInternes);
    } catch (erreur) {
      return {
        ...base,
        erreur: `Motif ou drapeaux invalides : ${erreur instanceof Error ? erreur.message : "erreur de compilation"}`,
      };
    }

    const avisDecoupage: string[] = [];
    const resultats: ResultatChaine[] = [];
    let total = 0;
    let partiel = false;
    let tronque = false;
    let plafondRestant = CORRESPONDANCES_MAX_TOTAL;

    for (let i = 0; i < input.chaines.length; i += 1) {
      if (Date.now() >= echeance) {
        partiel = true;
        avisDecoupage.push(`chaîne ${i + 1} : non traitée (échéance déjà atteinte)`);
        resultats.push({ index: i, chaine: input.chaines[i], correspondances: [], nombre: 0, tronque: false, partiel: true });
        continue;
      }
      if (plafondRestant <= 0) {
        tronque = true;
        resultats.push({ index: i, chaine: input.chaines[i], correspondances: [], nombre: 0, tronque: true, partiel: false });
        continue;
      }
      const recherche = rechercherDansChaine(regex, input.chaines[i], echeance, plafondRestant);
      partiel = partiel || recherche.partiel;
      tronque = tronque || recherche.tronque;
      if (recherche.decoupee) avisDecoupage.push(`chaîne ${i + 1} : traitée en fenêtres de ${TAILLE_FENETRE} caractères (chevauchement ${CHEVAUCHEMENT})`);
      resultats.push({
        index: i,
        chaine: input.chaines[i],
        correspondances: recherche.correspondances,
        nombre: recherche.correspondances.length,
        tronque: recherche.tronque,
        partiel: recherche.partiel,
      });
      total += recherche.correspondances.length;
      plafondRestant -= recherche.correspondances.length;
    }

    if (avisReDoS) avis.push("quantificateurs imbriqués détectés dans le motif : risque ReDoS typique — le résultat reste réel mais peut être partiel (échéance)");
    if (avisDecoupage.length > 0) {
      avis.push(`découpage actif : les ancres ^/$ ne correspondent qu'aux débuts/fins de fenêtre (les fenêtres bornent la portée de chaque appel — un appel unique ne peut pas être interrompu)`);
    }
    if (partiel) avis.push("échéance atteinte : les correspondances restituées sont réelles mais incomplètes");

    return {
      succes: true,
      pattern: input.pattern,
      drapeaux,
      avisReDoS,
      avis,
      resultats,
      totalCorrespondances: total,
      partiel,
      tronque,
      deadlineMs: input.deadlineMs,
    };
  },
};
