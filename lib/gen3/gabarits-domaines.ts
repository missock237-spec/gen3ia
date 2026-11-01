/**
 * it.72 — MATIÈRE DIFFÉRENCIÉE PAR GABARITS : LA SIGNATURE STRUCTURELLE
 * PAR DOMAINE (levier №1 déclaré it.71 §7.1, mesuré par la campagne
 * scripts/campagne-gabarits-domaines-it72.ts).
 *
 * Demandes propriétaires (permanentes) :
 *  - « entraîne gen3 dans tous les domaines… continue jusqu'à ce qu'il
 *    atteigne le niveau requis » ;
 *  - « un système qui apprend du générateur de dataset, pour qu'il
 *    puisse toujours continuer à s'améliorer en continu » (it.65) ;
 *  - « depuis tes propres serveurs locaux, 1 million de données par
 *    domaine » — l'ESPACE COMBINATOIRE par domaine reste ≫ 1 000 000 ;
 *  - « fais en sorte qu'il soit capable de répondre à des questions qui
 *    rentrent dans son cadre d'apprentissage ».
 *
 * LE PROBLÈME MESURÉ (carte des interférences it.70 §3.4 + réfutation
 * du budget it.71 §3.1) : le générateur it.65 partage les 4 MÊMES gabarits
 * (mêmes positions de squelette) et les MÊMES lexiques génériques entre
 * les 19 domaines — or la colonne corticale dépend du token ET DE SA
 * POSITION (phase = hash(token) + i×0.618, analyserOndeTexte) : deux
 * textes de domaines différents partagent ~70 % de leurs tokens aux
 * MÊMES positions → collisions de colonnes → interférences croisées
 * 0,40–0,55 → le porteur de certains domaines perd la discrimination
 * (C3 14/19, 5 échecs stables au millième).
 *
 * LE LEVIER (cette module) : une SIGNATURE STRUCTURELLE PAR DOMAINE —
 *  1. 8 gabarits FR + 8 EN à ORDRES DE MOTS distincts (le tokenizer
 *     supprime la ponctuation : seuls l'ordre et le nombre de mots
 *     décorellent les positions) — chaque domaine n'en utilise qu'une
 *     fenêtre rotée par son INDICE CHARTE ;
 *  2. des TRANCHES rotées des lexiques génériques (formats/cadres/
 *     qualificatifs/connecteurs — mots de fonction générés, jamais des
 *     faits de domaine) — deux domaines lisent des valeurs différentes
 *     au même indice ;
 *  3. le vocabulaire de DOMAINE reste EXCLUSIVEMENT celui de la CHARTE
 *     (taches/motsCles/outils/label — zéro invention, ancrage vérifié
 *     par la garde 41ᵉ).
 *
 * HONNÊTETÉ ET NON-RÉGRESSION :
 *  - la bijection it.65 (generateur-datasets.texteGenere) reste FIGÉE
 *    bit à bit — les artefacts commis it.65/69/70/71 restent
 *    reproductibles (garde 41ᵉ : ancre figée) ;
 *  - cette famille est une NOUVELLE bijection (même structure
 *    mixte-radix, radices élargies) : chaque (id, i) → UN texte unique,
 *    déterministe, reproductible ;
 *  - le GAIN du levier est MESURABLE indépendamment du cortex :
 *    tauxCollisionPositionnelle (tokens égaux aux mêmes positions entre
 *    deux domaines) — la campagne publie avant/après, la garde
 *    l'exige strictement décroissant ;
 *  - ZÉRO service IA externe, tout est local et déterministe.
 */

import { tokenize } from "../neural/encoding/text-encoder";

import { lexiqueDuDomaine, type LexiqueDomaine } from "./generateur-datasets";
import { IDS_VOCATION as IDS_CHARTE } from "./vocation";

/* ------------------------------------------------------------------ */
/* Lexiques génériques ÉLARGIS (mots de FONCTION générés — le contenu  */
/* de domaine vient exclusivement de la charte).                       */
/* ------------------------------------------------------------------ */

const FORMATS_FR = [
  "synthèse", "rapport", "tableau", "note", "plan d'action", "audit", "fiche",
  "comparatif", "résumé", "protocole", "liste de contrôle", "dossier", "mémo",
  "compte rendu", "relevé", "bilan", "fiche réflexe", "synthèse éclair",
  "note de cadrage", "tableau de bord", "échéancier", "registre", "cartographie",
  "glossaire", "point d'étape", "feuille de route", "vade-mecum", "état des lieux",
] as const;

const FORMATS_EN = [
  "summary", "report", "table", "note", "action plan", "audit", "sheet",
  "comparison", "digest", "protocol", "checklist", "file", "memo",
  "minutes", "statement", "balance", "quick sheet", "flash summary",
  "framing note", "dashboard", "timeline", "register", "mapping",
  "glossary", "checkpoint", "roadmap", "handbook", "status review",
] as const;

const CADRES_FR = [
  "2024", "2025", "2026", "T1 2026", "T2 2026", "T3 2026", "T4 2026",
  "trimestre en cours", "cette semaine", "ce mois-ci", "cette année",
  "prochaine échéance", "dernier cycle", "budget annuel", "sous 48 heures",
  "sous 7 jours", "mi-année", "fin d'année", "début de mois", "en continu",
  "hebdomadaire", "mensuel", "semestriel", "à la demande", "chaque trimestre",
  "en deux temps", "en trois temps", "au fil de l'eau",
] as const;

const CADRES_EN = [
  "2024", "2025", "2026", "Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026",
  "current quarter", "this week", "this month", "this year", "next deadline",
  "last cycle", "annual budget", "within 48 hours", "within 7 days",
  "mid year", "year end", "month start", "continuously", "weekly", "monthly",
  "semi annual", "on demand", "every quarter", "in two steps", "in three steps",
  "as it flows",
] as const;

const QUALIFICATIFS_FR = [
  "précis", "sourcé", "vérifié", "chiffré", "complet", "honnête", "mesurable",
  "priorisé", "structuré", "à jour", "fiable", "exploitable", "clair",
  "documenté", "traçable", "reproductible", "concis", "pondéré", "audité",
  "réversible", "consolidé", "aligné", "lisible", "justifié", "comparé",
  "enrichi", "stabilisé", "vérifiable", "observable", "tracé", "maîtrisé",
  "partagé",
] as const;

const QUALIFICATIFS_EN = [
  "precise", "sourced", "verified", "quantified", "complete", "honest",
  "measurable", "prioritized", "structured", "up to date", "reliable",
  "usable", "clear", "documented", "traceable", "reproducible", "concise",
  "balanced", "audited", "reversible", "consolidated", "aligned", "readable",
  "justified", "compared", "enriched", "stabilized", "checkable", "observable",
  "traced", "controlled", "shared",
] as const;

const CONNECTEURS_FR = [
  "pour un", "visant un", "avec un", "autour d'un", "au service d'un", "orienté vers un",
] as const;

const CONNECTEURS_EN = [
  "for a", "aiming at a", "with a", "around a", "serving a", "oriented toward a",
] as const;

/** Chiffres (universels, partagés — le levier ne repose pas dessus). */
const CHIFFRES = [12, 24, 36, 48, 60, 120, 240, 500, 1000, 5000] as const;

/* ------------------------------------------------------------------ */
/* 8 GABARITS FR + 8 EN — ORDRES DE MOTS distincts (le tokenizer       */
/* supprime la ponctuation : ce sont les SQUELETTES DE MOTS qui        */
/* décorrellent les positions d'une langue à l'autre du domaine).      */
/* T = tache · M = motcle · O = outil · F = format · C = cadre ·       */
/* Q = qualificatif · N = chiffre · K = connecteur · L = label charte  */
/* ------------------------------------------------------------------ */

type Slots = {
  t: string; m: string; o: string; f: string; c: string; q: string; n: number; k: string; l: string;
};

const GABARITS_FR: ReadonlyArray<(s: Slots) => string> = [
  (s) => `gen3 — ${s.t} : ${s.m} (${s.o}) ; ${s.f} ${s.c} ${s.k} résultat ${s.q} sur ${s.n} éléments (${s.l}).`,
  (s) => `${s.l} : ${s.t} — ${s.m}, ${s.f} ${s.c} ${s.k} livrable ${s.q} (${s.n} données, outil ${s.o}).`,
  (s) => `mission gen3 : ${s.t} avec ${s.o} sur ${s.m} ; ${s.f} ${s.c} ${s.q} ${s.k} résultat couvrant ${s.n} enregistrements (${s.l}).`,
  (s) => `${s.l} — ${s.t} : traiter ${s.m} avec ${s.o}, produire un ${s.f} ${s.c}, ${s.q}, ${s.n} éléments (${s.k} livrable unique).`,
  (s) => `gen3 › ${s.t} et ${s.m} par ${s.o} : livrer un ${s.f} ${s.c} ${s.q} (${s.n} éléments, ${s.k} résultat tracé, ${s.l}).`,
  (s) => `${s.l} // ${s.t} ; ${s.o} au quotidien : ${s.f} ${s.c} ${s.q}, ${s.n} données (${s.k} suivi rigoureux).`,
  (s) => `avec ${s.o}, ${s.t} sur ${s.m} → ${s.f} ${s.c}, ${s.q} — ${s.n} éléments, ${s.l} (${s.k} livrable mesuré).`,
  (s) => `${s.t} — ${s.l} : ${s.m} et ${s.o}, puis ${s.f} ${s.c} ${s.q} sur ${s.n} éléments (${s.k} sortie unique).`,
];

const GABARITS_EN: ReadonlyArray<(s: Slots) => string> = [
  (s) => `gen3 — ${s.t}: ${s.m} (${s.o}); ${s.f} ${s.c} ${s.k} ${s.q} result over ${s.n} items (${s.l}).`,
  (s) => `${s.l}: ${s.t} — ${s.m}, ${s.f} ${s.c} ${s.k} ${s.q} deliverable (${s.n} records, tool ${s.o}).`,
  (s) => `gen3 mission: ${s.t} with ${s.o} on ${s.m}; ${s.f} ${s.c} ${s.q} ${s.k} result covering ${s.n} verified records (${s.l}).`,
  (s) => `${s.l} — ${s.t}: process ${s.m} with ${s.o}, produce a ${s.f} ${s.c}, ${s.q}, ${s.n} items (single ${s.k} deliverable).`,
  (s) => `gen3 › ${s.t} and ${s.m} via ${s.o}: deliver a ${s.f} ${s.c} ${s.q} (${s.n} items, ${s.k} traced result, ${s.l}).`,
  (s) => `${s.l} // ${s.t}; ${s.o} daily: ${s.f} ${s.c} ${s.q}, ${s.n} records (${s.k} rigorous follow up).`,
  (s) => `with ${s.o}, ${s.t} on ${s.m} → ${s.f} ${s.c}, ${s.q} — ${s.n} items, ${s.l} (${s.k} measured deliverable).`,
  (s) => `${s.t} — ${s.l}: ${s.m} and ${s.o}, then ${s.f} ${s.c} ${s.q} over ${s.n} items (${s.k} single output).`,
];

/* ------------------------------------------------------------------ */
/* Rotation par domaine — fenêtre de gabarits + tranches de lexiques   */
/* ------------------------------------------------------------------ */

/** Rotation structurelle du domaine d'INDICE charte `k` : (k + ⌊k/4⌋) mod 8.
 *  Décorrélation mesurée : sur les 171 paires de domaines, ~10 gardent une
 *  fenêtre identique (vs 171/171 = 100 % dans la famille it.65) — la
 *  campagne publie le taux de collision avant/après, la garde l'exige. */
export function rotationGabarit(k: number): number {
  return (k + Math.floor(k / 4)) % GABARITS_FR.length;
}

/** Indice charte d'un domaine (erreur si id inconnu). */
export function indiceCharte(id: string): number {
  const i = IDS_CHARTE.indexOf(id);
  if (i < 0) throw new Error(`Domaine de vocation inconnu : ${id}`);
  return i;
}

/** Radices ÉLARGIES de la bijection différenciée (produit ≫ 10⁶/domaine). */
export function radicesDomaine(l: LexiqueDomaine): number[] {
  return [
    CONNECTEURS_FR.length, // 6
    CHIFFRES.length, // 10
    QUALIFICATIFS_FR.length, // 32
    CADRES_FR.length, // 28
    FORMATS_FR.length, // 28
    Math.max(1, l.outils.length),
    Math.max(1, l.motsCles.length),
    Math.max(1, l.taches.length),
    4, // slots de gabarit
    2, // langue
  ];
}

/** Espace combinatoire du domaine (produit des radices élargies). */
export function espaceCombinatoireDomaine(l: LexiqueDomaine): number {
  let p = 1;
  for (const r of radicesDomaine(l)) p *= r;
  return p;
}

/** Texte différencié n° `i` du domaine `id` — bijection mixte-radix
 *  (même structure que it.65 : chaque digit → UNE source, unicité
 *  garantie par la construction ; déterministe). */
export function texteDomaine(id: string, i: number): string {
  const l = lexiqueDuDomaine(id);
  const k = indiceCharte(id);
  const rot = rotationGabarit(k);
  let reste = i;
  const radices = radicesDomaine(l);
  const d: number[] = [];
  for (const r of radices) {
    const digit = reste % r;
    d.push(digit);
    reste = (reste - digit) / r;
  }
  const fr = d[9] === 0;
  const slot = d[8];
  const tache = l.taches[d[7] % l.taches.length] ?? "tâche de vocation";
  const motcle = l.motsCles[d[6] % l.motsCles.length] ?? "vocation";
  const outil = l.outils[d[5] % l.outils.length] ?? "registre gen3";
  // Tranches ROTÉES par domaine : deux domaines lisent des valeurs
  // différentes des lexiques génériques au même indice (stride 5, premier
  // avec 28 et 32 : collisions de tranche uniquement pour ≈ 7 distances
  // de charte sur 18 — mesuré par la garde).
  const format = fr
    ? (FORMATS_FR[(k * 5 + d[4]) % FORMATS_FR.length] ?? "synthèse")
    : (FORMATS_EN[(k * 5 + d[4]) % FORMATS_EN.length] ?? "summary");
  const cadre = fr
    ? (CADRES_FR[(k * 5 + d[3]) % CADRES_FR.length] ?? "2026")
    : (CADRES_EN[(k * 5 + d[3]) % CADRES_EN.length] ?? "2026");
  const qualif = fr
    ? (QUALIFICATIFS_FR[(k * 3 + d[2]) % QUALIFICATIFS_FR.length] ?? "précis")
    : (QUALIFICATIFS_EN[(k * 3 + d[2]) % QUALIFICATIFS_EN.length] ?? "precise");
  const chiffre = CHIFFRES[d[1]] ?? 12;
  const connecteur = fr
    ? (CONNECTEURS_FR[(k * 5 + d[0]) % CONNECTEURS_FR.length] ?? "pour un")
    : (CONNECTEURS_EN[(k * 5 + d[0]) % CONNECTEURS_EN.length] ?? "for a");
  const slots: Slots = { t: tache, m: motcle, o: outil, f: format, c: cadre, q: qualif, n: chiffre, k: connecteur, l: l.label };
  const gabarits = fr ? GABARITS_FR : GABARITS_EN;
  const gabarit = gabarits[(slot + rot) % gabarits.length]!;
  return gabarit(slots);
}

/** Paire conversationnelle différenciée (motif roté par domaine + réponse
 *  = texte différencié). Mêmes digits de motif que it.65 (i, i/4, i/4t)
 *  mais 8 formes de question FR rotées par l'INDICE CHARTE — la FORME
 *  question→réponse porte la signature du domaine. */
export function paireDomaine(id: string, i: number): { motif: string; reponse: string; theme: string } {
  const l = lexiqueDuDomaine(id);
  const k = indiceCharte(id);
  const tache = l.taches[Math.floor(i / 4) % l.taches.length] ?? l.taches[0] ?? "tâche de vocation";
  const motcle = l.motsCles[
    Math.floor(i / (4 * Math.max(1, l.taches.length))) % Math.max(1, l.motsCles.length)
  ] ?? "vocation";
  const forme = (i + k) % MOTIFS_FR.length;
  const motif = MOTIFS_FR[forme]!(tache, motcle, l.label.toLowerCase(), l.label);
  return { motif, reponse: texteDomaine(id, i), theme: l.label };
}

/** 8 formes de question FR (ordres de mots distincts, rotées par domaine). */
const MOTIFS_FR: ReadonlyArray<(t: string, m: string, lb: string, LB: string) => string> = [
  (t, m, lb) => `gen3, ${t} (${m}) pour ${lb} — que me proposes-tu ?`,
  (t, m, lb) => `J'ai besoin d'un accompagnement en ${lb} : ${t}, axe ${m}.`,
  (t, m, lb, LB) => `Peux-tu t'occuper de ${t.toLowerCase()} sur ${m} (${LB}) ?`,
  (t, m, lb, LB) => `${LB} : je veux ${t.toLowerCase()} sur ${m} avec un résultat mesuré.`,
  (t, m, lb) => `Sur ${m}, en ${lb} : organise ${t.toLowerCase()} et montre le résultat.`,
  (t, m, lb, LB) => `${LB} — dossier ${m} : ${t}, quels livrables concrets ?`,
  (t, m, lb) => `Aide-moi en ${lb} : ${t}, focus ${m}, un résultat chiffré s'il te plaît.`,
  (t, m, lb) => `Pour ${lb}, prends en charge ${t.toLowerCase()} autour de ${m}.`,
];

/* ------------------------------------------------------------------ */
/* MESURE DU LEVIER — collision positionnelle (indépendante du cortex) */
/* ------------------------------------------------------------------ */

/** Taux de tokens ÉGAUX AUX MÊMES POSITIONS entre deux textes
 *  (0 = aucun, 1 = identiques) — c'est LE canal d'interférence mesuré
 *  it.70 §3.4 : même token + même position → même onde → mêmes colonnes. */
export function tauxCollisionPositionnelle(texteA: string, texteB: string): number {
  const a = tokenize(texteA);
  const b = tokenize(texteB);
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let egaux = 0;
  for (let p = 0; p < Math.min(a.length, b.length); p++) {
    if (a[p] === b[p]) egaux += 1;
  }
  return egaux / n;
}

/** Lot de textes consécutifs (déterministe, mémoire O(taille)). */
export function genererLotDomaine(id: string, debut: number, taille: number): string[] {
  const out: string[] = [];
  for (let i = debut; i < debut + taille; i++) out.push(texteDomaine(id, i));
  return out;
}
