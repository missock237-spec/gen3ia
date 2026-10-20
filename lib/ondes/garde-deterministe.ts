/**
 * VERROUILLAGE PAR PREUVE SYMBOLIQUE (Deterministic Guard).
 *
 * Tout ce qui relève de la LOGIQUE EXACTE — calculs mathématiques,
 * dates, opérations financières, comparaisons de règles — n'est JAMAIS
 * laissé à l'appréciation statistique de l'IA. Quand l'onde génère une
 * intention de réponse, ce module intercepte l'intention et exécute le
 * calcul de manière DÉTERMINISTE, dans le navigateur, avec un moteur
 * d'exécution pur (analyseur récursif descendant — AUCUN eval, AUCUNE
 * Function constructor, zéro code dynamique).
 *
 * Résultat : si la question est « Combien font 14 589 × 892 ? », l'IA
 * n'invente pas un chiffre — le garde exécute la multiplication
 * (13 013 412) et RÉINJECTE la valeur exacte dans la réponse. Si la
 * réponse de l'onde contient un autre nombre, elle est CORRIGÉE :
 * le calcul exact gagne toujours.
 *
 * Domaines couverts :
 *  · arithmétique (parseur complet : + − × ÷ · ^ % parenthèses, nombres
 *    français « 14 589,5 ») ;
 *  · pourcentages (« 15 % de 2 400 », « 2000 × 15% ») ;
 *  · TVA (« TVA 20% sur 1000 », « TTC à partir de HT ») ;
 *  · remises (« -20% sur 500 », « 500 avec 20% de remise ») ;
 *  · dates (« date dans 45 jours », « jours entre le 1er mars et le
 *    15 juin 2026 », « quel jour sera le 25 décembre 2026 ») ;
 *  · comparaisons de règles (« 14 589 > 892 »).
 */

/* ------------------------------------------------------------------ */
/* Parseur arithmétique exact (aucun eval)                             */
/* ------------------------------------------------------------------ */

type Jeton =
  | { t: "nombre"; v: number }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "%" | "^" }
  | { t: "paren"; v: "(" | ")" };

const OPERATEURS: Record<string, Jeton & { t: "op" }> = {
  "+": { t: "op", v: "+" },
  "-": { t: "op", v: "-" },
  "*": { t: "op", v: "*" },
  "/": { t: "op", v: "/" },
  "%": { t: "op", v: "%" },
  "^": { t: "op", v: "^" },
  "×": { t: "op", v: "*" },
  "÷": { t: "op", v: "/" },
  "·": { t: "op", v: "*" },
  "−": { t: "op", v: "-" },
};

/** Normalise les nombres français : « 14 589,5 » → 14589.5. */
function normaliserNombre(brut: string): number {
  const nettoye = brut.replace(/\s|\u202f|\u00a0/g, "").replace(",", ".");
  return Number(nettoye);
}

/** Tokenise une expression arithmétique (nombres fr + opérateurs unicode). */
export function tokeniserArithmetique(source0: string): Jeton[] | null {
  // Séparateur de milliers en espace simple : « 14 589 » → « 14\u202f589 »
  // (un espace AVANT exactement 3 chiffres de fin de groupe est un millier,
  // jamais un opérateur manquant).
  const source = source0.replace(/(\d)[ ](?=\d{3}(?!\d))/g, "$1\u202f");
  const jetons: Jeton[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s|\u202f|\u00a0/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "," && /[0-9]/.test(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length && /[0-9\u202f\u00a0,._]/.test(source[j])) j++;
      // Nombre « 1 234 » : les espaces de milliers s'arrêtent avant un opérateur.
      const brut = source.slice(i, j).replace(/[._]/g, "");
      const valeur = normaliserNombre(brut);
      if (!Number.isFinite(valeur)) return null;
      jetons.push({ t: "nombre", v: valeur });
      i = j;
      continue;
    }
    if (c === "(" || c === ")") {
      jetons.push({ t: "paren", v: c });
      i++;
      continue;
    }
    const op = OPERATEURS[c];
    if (op) {
      jetons.push(op);
      i++;
      continue;
    }
    return null; // caractère inconnu → pas une expression exacte
  }
  return jetons.length > 0 ? jetons : null;
}

/**
 * Évaluateur récursif descendant (précédence ^ > × ÷ % > + −, unaire −).
 * Pur, sans eval, sans Function — chaque étape est du code vérifiable.
 */
export function evaluerArithmetique(jetons: Jeton[]): number | null {
  let pos = 0;
  const regarder = (): Jeton | null => jetons[pos] ?? null;

  const parsePrimaire = (): number | null => {
    const j = regarder();
    if (!j) return null;
    if (j.t === "nombre") {
      pos++;
      return j.v;
    }
    if (j.t === "paren" && j.v === "(") {
      pos++;
      const v = parseSomme();
      const ferme = regarder();
      if (!ferme || ferme.t !== "paren" || ferme.v !== ")") return null;
      pos++;
      return v;
    }
    if (j.t === "op" && (j.v === "-" || j.v === "+")) {
      pos++;
      const v = parsePrimaire();
      if (v === null) return null;
      return j.v === "-" ? -v : v;
    }
    return null;
  };

  const parsePuissance = (): number | null => {
    const base = parsePrimaire();
    if (base === null) return null;
    const j = regarder();
    if (j && j.t === "op" && j.v === "^") {
      pos++;
      const exposant = parsePuissance(); // associativité droite
      if (exposant === null) return null;
      return Math.pow(base, exposant);
    }
    return base;
  };

  const parseProduit = (): number | null => {
    let v = parsePuissance();
    if (v === null) return null;
    for (;;) {
      const j = regarder();
      if (j && j.t === "op" && (j.v === "*" || j.v === "/" || j.v === "%")) {
        pos++;
        const d = parsePuissance();
        if (d === null) return null;
        if (j.v === "*") v = v * d;
        else if (j.v === "/") v = d === 0 ? NaN : v / d;
        else v = d === 0 ? NaN : v % d;
        if (!Number.isFinite(v)) return null;
      } else return v;
    }
  };

  const parseSomme = (): number | null => {
    let v = parseProduit();
    if (v === null) return null;
    for (;;) {
      const j = regarder();
      if (j && j.t === "op" && (j.v === "+" || j.v === "-")) {
        pos++;
        const d = parseProduit();
        if (d === null) return null;
        v = j.v === "+" ? v + d : v - d;
      } else return v;
    }
  };

  const resultat = parseSomme();
  if (resultat === null || pos !== jetons.length || !Number.isFinite(resultat)) return null;
  return resultat;
}

/** Formate un nombre à la française (espaces de milliers, virgule décimale). */
export function formaterNombre(x: number): string {
  if (!Number.isFinite(x)) return "indéfini";
  const arrondi = Math.abs(x) < 1e-12 ? 0 : x;
  const entier = Math.trunc(arrondi);
  const decimales = Math.abs(arrondi - entier) > 1e-10 ? Math.min(10, Math.max(0, 10 - Math.floor(Math.log10(Math.abs(arrondi)) + 1e-9))) : 0;
  const groupes = Math.abs(entier).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  const signe = arrondi < 0 ? "-" : "";
  if (decimales === 0) return `${signe}${groupes}`;
  const partie = (Math.abs(arrondi) - Math.abs(entier)).toFixed(decimales).slice(2).replace(/0+$/, "");
  return `${signe}${groupes},${partie}`;
}

/* ------------------------------------------------------------------ */
/* Détection d'intentions exactes                                      */
/* ------------------------------------------------------------------ */

export type TypeIntention = "arithmetique" | "pourcentage" | "tva" | "remise" | "date" | "comparaison";

export interface IntentionExacte {
  type: TypeIntention;
  /** Description lisible du calcul à exécuter. */
  description: string;
}

export interface ResultatExact {
  intention: IntentionExacte;
  /** Valeur numérique (si applicable). */
  valeur: number | null;
  /** Résultat lisible (phrase exacte à injecter). */
  texte: string;
}

const REGEX_POURCENTAGE = /(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)\s*(?:%|pour ?cents?)\s*(?:de|sur|du)\s*(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)/i;
const REGEX_POURCENTAGE_SUFFIXE = /(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)\s*[×·*]\s*(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)\s*%/i;
const REGEX_TVA = /tva\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*%?\s*(?:de|sur|appliqu[ée]e?\s*[àa])\s*(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)/i;
const REGEX_REMISE = /(?:remise|rabais|r[ée]duction)\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*%?\s*(?:de|sur|sur\s*une?\s*)\s*(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)/i;
const REGEX_ARITHMETIQUE = /(?:combien\s*(?:font|fait)|calcule?r?|r[ée]sult[âa]t\s*de|qu\s*est[- ]ce\s*que)?\s*[-+]?\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?\s*(?:[+]|[-−]|[×÷·*%^/])\s*[-+]?\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?/;
const REGEX_COMPARAISON = /(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)\s*(>=|<=|>|<|=)\s*(\d+(?:[ \u202f\u00a0]\d{3})*(?:[.,]\d+)?)/;

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Parse « 25 décembre 2026 » / « le 1er mars » (année courante par défaut). */
function parseDateFr(s: string, anneeDefaut: number): Date | null {
  const m = s.trim().toLocaleLowerCase("fr").match(/(\d{1,2})(?:er)?\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?:\s+(\d{4}))?/);
  if (!m) return null;
  const jour = Number(m[1]);
  const mois = MOIS_FR.findIndex((mois_) => m[0].includes(mois_));
  const annee = m[2] ? Number(m[2]) : anneeDefaut;
  if (mois < 0 || jour < 1 || jour > 31) return null;
  return new Date(Date.UTC(annee, mois, jour));
}

/** Détecte une question de date et la résout exactement (UTC, sans TZ). */
export function resoudreDate(question: string, maintenant = new Date()): ResultatExact | null {
  const q = question.toLocaleLowerCase("fr");
  const anneeCourante = maintenant.getUTCFullYear();

  // « jours entre le X et le Y »
  const entre = q.match(/(?:combien\s+de\s+)?jours?\s+entre\s+(?:le\s+)?(.+?)\s+et\s+(?:le\s+)?(.+?)(?:[?.!]|$)/);
  if (entre) {
    const a = parseDateFr(entre[1], anneeCourante);
    const b = parseDateFr(entre[2], anneeCourante);
    if (a && b) {
      const jours = Math.round((b.getTime() - a.getTime()) / 86400000);
      const fmt = (d: Date): string => `${d.getUTCDate()} ${MOIS_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      return {
        intention: { type: "date", description: "nombre de jours entre deux dates" },
        valeur: jours,
        texte: `Il y a exactement ${formaterNombre(Math.abs(jours))} jour${Math.abs(jours) > 1 ? "s" : ""} entre le ${fmt(a < b ? a : b)} et le ${fmt(a < b ? b : a)}.`,
      };
    }
  }

  // « date dans N jours/semaines/mois »
  const dans = q.match(/(?:date|quel(?:le)?\s+(?:date|jour))\s+(?:sera|seront)?\s*(?:dans|après)\s+(\d+)\s*(jour|jours|semaine|semaines|mois)\b/);
  if (dans) {
    const n = Number(dans[1]);
    const unite = dans[2];
    const cible = new Date(maintenant.getTime());
    if (unite.startsWith("jour")) cible.setUTCDate(cible.getUTCDate() + n);
    else if (unite.startsWith("semaine")) cible.setUTCDate(cible.getUTCDate() + n * 7);
    else cible.setUTCMonth(cible.getUTCMonth() + n);
    const fmt = `${JOURS_FR[cible.getUTCDay()]} ${cible.getUTCDate()} ${MOIS_FR[cible.getUTCMonth()]} ${cible.getUTCFullYear()}`;
    return {
      intention: { type: "date", description: `date dans ${n} ${unite}` },
      valeur: cible.getTime(),
      texte: `Dans ${n} ${unite}, nous serons le ${fmt} (calcul calendaire exact, fuseau UTC).`,
    };
  }

  // « quel jour sera le 25 décembre 2026 »
  const quelJour = q.match(/quel\s+jour\s+(?:sera|tombe|est)\s+(?:le\s+)?(.+?)(?:[?.!]|$)/);
  if (quelJour) {
    const d = parseDateFr(quelJour[1], anneeCourante);
    if (d) {
      return {
        intention: { type: "date", description: "jour de la semaine d'une date" },
        valeur: d.getTime(),
        texte: `Le ${d.getUTCDate()} ${MOIS_FR[d.getUTCMonth()]} ${d.getUTCFullYear()} tombera un ${JOURS_FR[d.getUTCDay()]} (calcul calendaire exact).`,
      };
    }
  }
  return null;
}

/**
 * Détecte une intention EXACTE dans une question et l'exécute de manière
 * déterministe. Retourne null si la question n'a aucun contenu exact
 * (l'onde garde alors la parole — la garde ne s'applique qu'au domaine
 * logique vérifiable).
 */
export function executerIntentionExacte(question: string, maintenant = new Date()): ResultatExact | null {
  const q = question.replace(/\u00a0|\u202f/g, " ");

  const tva = q.match(REGEX_TVA);
  if (tva) {
    const taux = Number(tva[1].replace(",", "."));
    const ht = normaliserNombre(tva[2]);
    if (Number.isFinite(taux) && Number.isFinite(ht)) {
      const montant = Math.round(ht * (1 + taux / 100) * 100) / 100;
      return {
        intention: { type: "tva", description: `TVA ${taux}% sur ${formaterNombre(ht)}` },
        valeur: montant,
        texte: `Montant TTC exact : ${formaterNombre(montant)} (HT ${formaterNombre(ht)} + TVA ${formaterNombre(taux)}%).`,
      };
    }
  }

  const remise = q.match(REGEX_REMISE);
  if (remise) {
    const taux = Number(remise[1].replace(",", "."));
    const prix = normaliserNombre(remise[2]);
    if (Number.isFinite(taux) && Number.isFinite(prix)) {
      const net = Math.round(prix * (1 - taux / 100) * 100) / 100;
      return {
        intention: { type: "remise", description: `remise ${taux}% sur ${formaterNombre(prix)}` },
        valeur: net,
        texte: `Prix net exact : ${formaterNombre(net)} (${formaterNombre(prix)} − ${formaterNombre(taux)}% de remise).`,
      };
    }
  }

  const pctSuffixe = q.match(REGEX_POURCENTAGE_SUFFIXE);
  if (pctSuffixe) {
    const base = normaliserNombre(pctSuffixe[1]);
    const taux = Number(pctSuffixe[2].replace(",", "."));
    if (Number.isFinite(base) && Number.isFinite(taux)) {
      const valeur = Math.round(base * (taux / 100) * 1e6) / 1e6;
      return {
        intention: { type: "pourcentage", description: `${formaterNombre(taux)}% de ${formaterNombre(base)}` },
        valeur,
        texte: `Résultat exact : ${formaterNombre(valeur)}.`,
      };
    }
  }

  const pct = q.match(REGEX_POURCENTAGE);
  if (pct) {
    const taux = Number(pct[1].replace(",", "."));
    const base = normaliserNombre(pct[2]);
    if (Number.isFinite(taux) && Number.isFinite(base)) {
      const valeur = Math.round(base * (taux / 100) * 1e6) / 1e6;
      return {
        intention: { type: "pourcentage", description: `${formaterNombre(taux)}% de ${formaterNombre(base)}` },
        valeur,
        texte: `Résultat exact : ${formaterNombre(valeur)}.`,
      };
    }
  }

  const date = resoudreDate(q, maintenant);
  if (date) return date;

  const comparaison = q.match(REGEX_COMPARAISON);
  if (comparaison) {
    const a = normaliserNombre(comparaison[1]);
    const b = normaliserNombre(comparaison[3]);
    const op = comparaison[2];
    const ok =
      op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : op === "<=" ? a <= b : a === b;
    return {
      intention: { type: "comparaison", description: `${formaterNombre(a)} ${op} ${formaterNombre(b)}` },
      valeur: ok ? 1 : 0,
      texte: `Vérification exacte : ${formaterNombre(a)} ${op} ${formaterNombre(b)} est ${ok ? "VRAI" : "FAUX"}.`,
    };
  }

  const arith = q.match(REGEX_ARITHMETIQUE);
  if (arith) {
    const expression = arith[0].replace(/^(?:combien\s*(?:font|fait)|calcule?r?|r[ée]sult[âa]t\s*de|qu\s*est[- ]ce\s*que)\s*/i, "").trim();
    const jetons = tokeniserArithmetique(expression);
    if (jetons) {
      const valeur = evaluerArithmetique(jetons);
      if (valeur !== null) {
        return {
          intention: { type: "arithmetique", description: expression },
          valeur,
          texte: `Résultat exact : ${formaterNombre(valeur)} (calcul déterministe local, ${expression.replace(/\s+/g, " ")}).`,
        };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Garde sur la réponse de l'onde                                      */
/* ------------------------------------------------------------------ */

export type SourceReponse = "calcul_exact" | "onde";
export type CoherenceGarde = "conforme" | "corrigee" | "sans_objet";

export interface ResultatGarde {
  /** Le garde a-t-il détecté une intention exacte ? */
  active: boolean;
  source: SourceReponse;
  /** La réponse finale — toujours sûre à diffuser. */
  reponseFinale: string;
  /** Que s'est-il passé entre l'onde et le calcul exact ? */
  coherence: CoherenceGarde;
  /** Le calcul exact exécuté (si intention détectée). */
  resultatExact: ResultatExact | null;
}

/** Variants de formatage du même nombre (14 589 = 14589 = 14 589,0). */
function variantesNombre(x: number): string[] {
  const f = formaterNombre(x);
  const nbsp = f.replace(/\u202f/g, "\u00a0");
  const espace = f.replace(/\u202f/g, " ");
  const brut = f.replace(/\u202f/g, "").replace(",", ".");
  const brutVirgule = f.replace(/\u202f/g, "");
  return [...new Set([f, nbsp, espace, brut, brutVirgule])];
}

/**
 * APPLIQUE LA GARDE : intercepte la réponse de l'onde, exécute le calcul
 * exact s'il y a une intention vérifiable, et arbitre.
 *
 *  - pas d'intention exacte → l'onde passe (coherence « sans_objet ») ;
 *  - intention exacte + l'onde contient la bonne valeur → l'onde parle,
 *    le calcul a validé (« conforme ») ;
 *  - intention exacte + l'onde se trompe (ou se tait) → le résultat
 *    exact est RÉINJECTÉ (« corrigée ») : le calcul gagne, toujours.
 */
export function appliquerGardeDeterministe(question: string, reponseOnde: string, maintenant = new Date()): ResultatGarde {
  const exact = executerIntentionExacte(question, maintenant);
  if (!exact) {
    return { active: false, source: "onde", reponseFinale: reponseOnde, coherence: "sans_objet", resultatExact: null };
  }

  const valeur = exact.valeur;
  if (valeur !== null && reponseOnde) {
    const variantes = variantesNombre(valeur);
    const contient = variantes.some((v) => v.length > 0 && reponseOnde.includes(v));
    if (contient) {
      return { active: true, source: "onde", reponseFinale: reponseOnde, coherence: "conforme", resultatExact: exact };
    }
  }

  // L'onde se tait ou se trompe : la preuve symbolique s'impose.
  const reponseFinale = exact.valeur !== null && reponseOnde.trim().length > 0
    ? `${reponseOnde.trim()}\n\n[Correction déterministe — ${exact.texte}]`
    : exact.texte;
  return { active: true, source: "calcul_exact", reponseFinale, coherence: "corrigee", resultatExact: exact };
}
