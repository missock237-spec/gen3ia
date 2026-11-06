/**
 * COMPARTIMENT MATH GEN3 (demande propriétaire : « les math, tu vas créer un
 * système qui sera connecté au cerveau de gen3, il va servir à réaliser les
 * opérations mathématiques et à résoudre des problèmes qui demandent un
 * calcul directement depuis le cerveau de gen3 »).
 *
 * PRINCIPE (honnête, déterministe, sûr) :
 *   - un ÉVALUATEUR D'EXPRESSIONS écrit à la main (tokenizer + descente
 *     récursive) — JAMAIS eval(), JAMAIS new Function() : une expression
 *     hostile ne peut exécuter aucun code ;
 *   - des SOLVEURS DE PROBLÈMES par familles (pourcentage, moyenne,
 *     conversion d'unités, aire, périmètre, Pythagore, partage, vitesse) —
 *     chaque réponse est CALCULÉE depuis la question posée, avec ses
 *     étapes : gen3 raisonne le calcul au lieu de réciter une paire
 *     mémorisée (complément de reponseInstantiee, qui reste en amont) ;
 *   - module PUR : aucune dépendance Node — le même compartiment répond
 *     côté serveur (moteur), côté API et côté tests.
 *
 * LIMITES DOCUMENTÉES : nombres finis (pas de calcul symbolique), fonctions
 * usuelles en radians (variantes *deg en degrés), % postfixé = /100.
 */

// ─── NORMALISATION ───────────────────────────────────────────────────────────

/** Normalise les symboles mathématiques Unicode vers l'ASCII calculable. */
export function normaliserExpression(brut: string): string {
  return brut
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/\u00a0|\u202f/g, " ");
}

// ─── ÉVALUATEUR D'EXPRESSIONS (tokenizer + descente récursive) ───────────────

const CONSTANTES: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

const FONCTIONS: Readonly<Record<string, (x: number) => number>> = {
  sqrt: Math.sqrt,
  racine: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sindeg: (x) => Math.sin((x * Math.PI) / 180),
  cosdeg: (x) => Math.cos((x * Math.PI) / 180),
  tandeg: (x) => Math.tan((x * Math.PI) / 180),
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  arrondi: Math.round,
  plancher: Math.floor,
  plafond: Math.ceil,
};

type Jeton =
  | { t: "nombre"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "par"; v: "(" | ")" }
  | { t: "pct" };

function tokeniser(expr: string): Jeton[] | null {
  const jetons: Jeton[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === " ") {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(expr[i + 1] ?? ""))) {
      // Nombre décimal (point ou virgule française) — « 1.000.000 » invalide.
      let j = i;
      let brut = "";
      let points = 0;
      while (j < expr.length && /[0-9.,]/.test(expr[j]!)) {
        const ch = expr[j]!;
        if (ch === ".") {
          points += 1;
          if (points > 1) return null;
          brut += ".";
        } else if (ch === ",") {
          brut += ".";
        } else {
          brut += ch;
        }
        j += 1;
      }
      const v = Number(brut);
      if (!Number.isFinite(v)) return null;
      jetons.push({ t: "nombre", v });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z]/.test(expr[j]!)) j += 1;
      jetons.push({ t: "ident", v: expr.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/^".includes(c)) {
      jetons.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    if (c === "(" || c === ")") {
      jetons.push({ t: "par", v: c });
      i += 1;
      continue;
    }
    if (c === "%") {
      jetons.push({ t: "pct" });
      i += 1;
      continue;
    }
    return null; // caractère inconnu — pas une expression calculable
  }
  return jetons;
}

/**
 * Évalue une expression arithmétique SANS eval — descente récursive :
 * somme → produit → puissance → unaire → postfixe % → primaire.
 * Retourne null si l'expression n'est pas calculable en entier
 * (identifiant inconnu, parenthèse déséquilibrée, reste non consommé).
 */
export function evaluerExpression(brut: string): number | null {
  const expr = normaliserExpression(brut).trim();
  if (expr.length === 0 || expr.length > 500) return null;
  const jetons = tokeniser(expr);
  if (!jetons || jetons.length === 0) return null;
  let pos = 0;

  const lit = (): Jeton | undefined => jetons[pos];
  const parseSomme = (): number | null => {
    let gauche = parseProduit();
    if (gauche === null) return null;
    while (
      lit()?.t === "op" &&
      ((lit() as { v: string }).v === "+" || (lit() as { v: string }).v === "-")
    ) {
      const op = (lit() as { v: string }).v;
      pos += 1;
      const droite = parseProduit();
      if (droite === null) return null;
      gauche = op === "+" ? gauche + droite : gauche - droite;
    }
    return gauche;
  };
  const parseProduit = (): number | null => {
    let gauche = parsePuissance();
    if (gauche === null) return null;
    while (
      lit()?.t === "op" &&
      ((lit() as { v: string }).v === "*" || (lit() as { v: string }).v === "/")
    ) {
      const op = (lit() as { v: string }).v;
      pos += 1;
      const droite = parsePuissance();
      if (droite === null) return null;
      if (op === "/" && droite === 0) return null; // division par zéro : non calculé
      gauche = op === "*" ? gauche * droite : gauche / droite;
    }
    return gauche;
  };
  const parsePuissance = (): number | null => {
    const base = parseUnaire();
    if (base === null) return null;
    if (lit()?.t === "op" && (lit() as { v: string }).v === "^") {
      pos += 1;
      const expo = parsePuissance(); // associativité à droite : 2^3^2 = 2^9
      if (expo === null) return null;
      return Math.pow(base, expo);
    }
    return base;
  };
  const parseUnaire = (): number | null => {
    let signe = 1;
    while (
      lit()?.t === "op" &&
      ((lit() as { v: string }).v === "-" || (lit() as { v: string }).v === "+")
    ) {
      if ((lit() as { v: string }).v === "-") signe = -signe;
      pos += 1;
    }
    const v = parsePostfixe();
    if (v === null) return null;
    return signe * v;
  };
  const parsePostfixe = (): number | null => {
    let v = parsePrimaire();
    if (v === null) return null;
    while (lit()?.t === "pct") {
      pos += 1;
      v = v / 100;
    }
    return v;
  };
  const parsePrimaire = (): number | null => {
    const j = lit();
    if (!j) return null;
    if (j.t === "nombre") {
      pos += 1;
      return j.v;
    }
    if (j.t === "par" && j.v === "(") {
      pos += 1;
      const v = parseSomme();
      if (v === null) return null;
      const ferme = lit();
      if (!ferme || ferme.t !== "par" || ferme.v !== ")") return null;
      pos += 1;
      return v;
    }
    if (j.t === "ident") {
      pos += 1;
      const f = FONCTIONS[j.v];
      if (f) {
        const ouvre = lit();
        if (!ouvre || ouvre.t !== "par") return null;
        pos += 1;
        const v = parseSomme();
        if (v === null) return null;
        const ferme = lit();
        if (!ferme || ferme.t !== "par" || ferme.v !== ")") return null;
        pos += 1;
        const r = f(v);
        return Number.isFinite(r) ? r : null;
      }
      if (j.v in CONSTANTES) return CONSTANTES[j.v]!;
      return null; // identifiant inconnu — refuse (jamais d'exécution)
    }
    return null;
  };

  const v = parseSomme();
  if (v === null || pos !== jetons.length) return null;
  return Number.isFinite(v) ? v : null;
}

/** true si le texte est une expression purement calculable (chiffres,
 * opérateurs, fonctions connues — aucun autre mot). */
export function estExpressionPure(brut: string): boolean {
  const expr = normaliserExpression(brut).trim();
  if (!/\d/.test(expr)) return false;
  if (!/[+\-*/^%]/.test(expr)) return false; // un calcul exige un opérateur
  if (!/^[\d\s+\-*/^().,%a-zA-Z]+$/.test(expr)) return false;
  return evaluerExpression(expr) !== null;
}

// ─── FORMATAGE ───────────────────────────────────────────────────────────────

/** Format français : arrondi au millionième, virgule décimale. */
export function formaterNombre(x: number): string {
  if (!Number.isFinite(x)) return "invalide";
  const arrondi = Math.round(x * 1e6) / 1e6;
  return (Object.is(arrondi, -0) ? 0 : arrondi).toString().replace(".", ",");
}

// ─── UNITÉS (conversions exactes par facteurs documentés) ────────────────────

interface UniteDef {
  readonly famille: string;
  readonly facteur: number;
  readonly symbole: string;
}

/** Facteurs EXACTS relatifs à l'unité de base de chaque famille
 * (vitesse : km/h de référence, m/s = 3,6 km/h — conversion directe). */
const UNITES: Readonly<Record<string, UniteDef>> = {
  mm: { famille: "longueur", facteur: 0.001, symbole: "mm" },
  cm: { famille: "longueur", facteur: 0.01, symbole: "cm" },
  m: { famille: "longueur", facteur: 1, symbole: "m" },
  km: { famille: "longueur", facteur: 1000, symbole: "km" },
  mg: { famille: "masse", facteur: 0.000001, symbole: "mg" },
  g: { famille: "masse", facteur: 0.001, symbole: "g" },
  kg: { famille: "masse", facteur: 1, symbole: "kg" },
  t: { famille: "masse", facteur: 1000, symbole: "t" },
  ms: { famille: "temps", facteur: 0.001, symbole: "ms" },
  s: { famille: "temps", facteur: 1, symbole: "s" },
  min: { famille: "temps", facteur: 60, symbole: "min" },
  h: { famille: "temps", facteur: 3600, symbole: "h" },
  ml: { famille: "volume", facteur: 0.001, symbole: "ml" },
  cl: { famille: "volume", facteur: 0.01, symbole: "cl" },
  l: { famille: "volume", facteur: 1, symbole: "l" },
  octet: { famille: "donnees", facteur: 1, symbole: "octet" },
  octets: { famille: "donnees", facteur: 1, symbole: "octet" },
  ko: { famille: "donnees", facteur: 1000, symbole: "ko" },
  mo: { famille: "donnees", facteur: 1000000, symbole: "mo" },
  go: { famille: "donnees", facteur: 1000000000, symbole: "go" },
  "km/h": { famille: "vitesse", facteur: 1, symbole: "km/h" },
  kmh: { famille: "vitesse", facteur: 1, symbole: "km/h" },
  "m/s": { famille: "vitesse", facteur: 3.6, symbole: "km/h" },
};

const NB_RE = "(-?\\d+(?:[.,]\\d+)?)";

function nombresDe(q: string): number[] {
  return [...q.matchAll(new RegExp(NB_RE, "g"))].map((m) =>
    Number(m[1]!.replace(",", ".")),
  );
}

// ─── RÉSOLUTION DE PROBLÈMES PAR FAMILLES ────────────────────────────────────

export type FamilleCalcul =
  | "expression"
  | "pourcentage"
  | "moyenne"
  | "conversion"
  | "aire"
  | "perimetre"
  | "pythagore"
  | "partage"
  | "vitesse"
  | null;

export interface ResultatCalcul {
  readonly resolu: boolean;
  readonly famille: FamilleCalcul;
  readonly valeur: number | null;
  readonly unite: string;
  readonly etapes: readonly string[];
  /** Expression effectivement évaluée (famille « expression »). */
  readonly expression?: string;
}

const NON_RESOLU: ResultatCalcul = {
  resolu: false,
  famille: null,
  valeur: null,
  unite: "",
  etapes: [],
};

/**
 * Résout un problème de calcul posé en français — la réponse est CALCULÉE
 * depuis la question (aucune paire mémorisée, aucun nombre figé).
 * Première famille reconnue gagnante (ordre documenté ci-dessous).
 */
export function resoudreProbleme(question: string): ResultatCalcul {
  const q = normaliserExpression(question.toLowerCase());
  // Version SANS ACCENTS pour les motifs d'intention : en JavaScript, \w ne
  // couvre pas « é » — « augmenté » / « réduit » / « périmètre » échapperaient
  // aux familles (leçon du garde : 200 augmenté de 10 % restait sans réponse).
  const qs = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 1. EXPRESSION EXPLICITE — « calcule 17*23 », « combien font (3+4)*2 ».
  const debarrassee = q
    .replace(/\b(calcule|calculer|combien font|combien fait|resultat de|résultat de|c'est quoi|combien)\b/g, " ")
    .replace(/[?!.;:]+/g, " ")
    .trim();
  if (debarrassee.length > 0 && estExpressionPure(debarrassee)) {
    const v = evaluerExpression(debarrassee);
    if (v !== null) {
      const expression = debarrassee.replace(/\s+/g, " ");
      return {
        resolu: true,
        famille: "expression",
        valeur: v,
        unite: "",
        etapes: [`${expression} = ${formaterNombre(v)}`],
        expression,
      };
    }
  }

  // 2. POURCENTAGE — « 15 % de 240 », « 200 augmenté de 10 % », « réduit de ».
  const mPctDe = qs.match(new RegExp(`${NB_RE}\\s*(?:%|pour ?cent|pourcents)\\s*(?:de|du|des|d')\\s*${NB_RE}`));
  if (mPctDe) {
    const p = Number(mPctDe[1]!.replace(",", "."));
    const total = Number(mPctDe[2]!.replace(",", "."));
    const v = (p / 100) * total;
    return {
      resolu: true,
      famille: "pourcentage",
      valeur: v,
      unite: "",
      etapes: [
        `${formaterNombre(p)} % de ${formaterNombre(total)}`,
        `= ${formaterNombre(p)} ÷ 100 × ${formaterNombre(total)}`,
        `= ${formaterNombre(p / 100)} × ${formaterNombre(total)}`,
        `= ${formaterNombre(v)}`,
      ],
    };
  }
  const mAug = qs.match(new RegExp(`${NB_RE}\\s*(?:augment|major)\\w*\\s*(?:de|par)\\s*${NB_RE}\\s*(?:%|pour ?cent)`));
  if (mAug) {
    const base = Number(mAug[1]!.replace(",", "."));
    const p = Number(mAug[2]!.replace(",", "."));
    const v = base * (1 + p / 100);
    return {
      resolu: true,
      famille: "pourcentage",
      valeur: v,
      unite: "",
      etapes: [
        `${formaterNombre(base)} augmenté de ${formaterNombre(p)} %`,
        `= ${formaterNombre(base)} × (1 + ${formaterNombre(p)} ÷ 100)`,
        `= ${formaterNombre(base)} × ${formaterNombre(1 + p / 100)}`,
        `= ${formaterNombre(v)}`,
      ],
    };
  }
  const mRed = qs.match(new RegExp(`${NB_RE}\\s*(?:redui|diminu|baiss)\\w*\\s*(?:de|par)\\s*${NB_RE}\\s*(?:%|pour ?cent)`));
  if (mRed) {
    const base = Number(mRed[1]!.replace(",", "."));
    const p = Number(mRed[2]!.replace(",", "."));
    const v = base * (1 - p / 100);
    return {
      resolu: true,
      famille: "pourcentage",
      valeur: v,
      unite: "",
      etapes: [
        `${formaterNombre(base)} diminué de ${formaterNombre(p)} %`,
        `= ${formaterNombre(base)} × (1 − ${formaterNombre(p)} ÷ 100)`,
        `= ${formaterNombre(base)} × ${formaterNombre(1 - p / 100)}`,
        `= ${formaterNombre(v)}`,
      ],
    };
  }
  const mPctDans = qs.match(/pour ?cent(?:age)?s?\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(?:dans|sur)\s*(\d+(?:[.,]\d+)?)/);
  if (mPctDans) {
    const part = Number(mPctDans[1]!.replace(",", "."));
    const tout = Number(mPctDans[2]!.replace(",", "."));
    if (tout !== 0) {
      const v = (part / tout) * 100;
      return {
        resolu: true,
        famille: "pourcentage",
        valeur: v,
        unite: "%",
        etapes: [
          `quel pourcentage de ${formaterNombre(part)} dans ${formaterNombre(tout)}`,
          `= ${formaterNombre(part)} ÷ ${formaterNombre(tout)} × 100`,
          `= ${formaterNombre(v)} %`,
        ],
      };
    }
  }

  // 3. CONVERSION D'UNITÉS — « convertis 2,5 km en m », « 3 h en min ».
  const mConv =
    qs.match(new RegExp(`(?:convertis?|convertir)\\s*${NB_RE}\\s*([a-z/]+)\\s*(?:en|vers)\\s*([a-z/]+)`)) ??
    qs.match(new RegExp(`${NB_RE}\\s*([a-z/]+)\\s*(?:en|vers)\\s*([a-z/]+)`));
  if (mConv) {
    const v = Number(mConv[1]!.replace(",", "."));
    const u1 = UNITES[mConv[2]!];
    const u2 = UNITES[mConv[3]!];
    if (u1 && u2 && u1.famille === u2.famille) {
      const enBase = v * u1.facteur;
      const r = enBase / u2.facteur;
      if (Number.isFinite(r)) {
        const arrondi = Math.round(r * 1e6) / 1e6;
        return {
          resolu: true,
          famille: "conversion",
          valeur: arrondi,
          unite: u2.symbole,
          etapes: [
            `${formaterNombre(v)} ${u1.symbole} → ${u2.symbole} (famille ${u1.famille})`,
            `facteurs : 1 ${u1.symbole} = ${formaterNombre(u1.facteur)} unité(s) de base ; 1 ${u2.symbole} = ${formaterNombre(u2.facteur)}`,
            `= ${formaterNombre(v)} × ${formaterNombre(u1.facteur)} ÷ ${formaterNombre(u2.facteur)}`,
            `= ${formaterNombre(arrondi)} ${u2.symbole}`,
          ],
        };
      }
    }
  }

  // 4. MOYENNE — « moyenne de 12, 14 et 16 ».
  if (/\bmoyenne\b/.test(qs)) {
    const ns = nombresDe(qs.replace(/moyenne/g, " "));
    if (ns.length >= 2) {
      const somme = ns.reduce((a, b) => a + b, 0);
      const v = somme / ns.length;
      return {
        resolu: true,
        famille: "moyenne",
        valeur: v,
        unite: "",
        etapes: [
          `valeurs : ${ns.map(formaterNombre).join(", ")} (${ns.length} valeurs)`,
          `somme = ${formaterNombre(somme)}`,
          `moyenne = ${formaterNombre(somme)} ÷ ${ns.length} = ${formaterNombre(v)}`,
        ],
      };
    }
  }

  // 5. AIRE — carré, rectangle, cercle, triangle.
  const mAireCarre = qs.match(/aire\b[^.]*carr[ée][^.]*c[ôo]t[ée]\s*(?:de\s*|mesurant\s*)?(\d+(?:[.,]\d+)?)/);
  if (mAireCarre) {
    const c = Number(mAireCarre[1]!.replace(",", "."));
    return {
      resolu: true,
      famille: "aire",
      valeur: c * c,
      unite: "u²",
      etapes: [
        `aire d'un carré = côté × côté`,
        `= ${formaterNombre(c)} × ${formaterNombre(c)} = ${formaterNombre(c * c)}`,
      ],
    };
  }
  const mAireRect = qs.match(/aire\b[^.]*rectangle[^.]*longueur\s*(?:de\s*)?(\d+(?:[.,]\d+)?)[^.]*largeur\s*(?:de\s*)?(\d+(?:[.,]\d+)?)/);
  if (mAireRect) {
    const L = Number(mAireRect[1]!.replace(",", "."));
    const l = Number(mAireRect[2]!.replace(",", "."));
    return {
      resolu: true,
      famille: "aire",
      valeur: L * l,
      unite: "u²",
      etapes: [
        `aire d'un rectangle = longueur × largeur`,
        `= ${formaterNombre(L)} × ${formaterNombre(l)} = ${formaterNombre(L * l)}`,
      ],
    };
  }
  const mAireCercle = qs.match(/aire\b[^.]*cercle[^.]*rayon\s*(?:de\s*|mesurant\s*)?(\d+(?:[.,]\d+)?)/);
  if (mAireCercle) {
    const r = Number(mAireCercle[1]!.replace(",", "."));
    const v = Math.PI * r * r;
    return {
      resolu: true,
      famille: "aire",
      valeur: v,
      unite: "u²",
      etapes: [
        `aire d'un cercle = π × rayon²`,
        `= π × ${formaterNombre(r)}² = π × ${formaterNombre(r * r)} = ${formaterNombre(v)} (π ≈ 3,141592)`,
      ],
    };
  }
  const mAireTri = qs.match(/aire\b[^.]*triangle[^.]*base\s*(?:de\s*)?(\d+(?:[.,]\d+)?)[^.]*hauteur\s*(?:de\s*)?(\d+(?:[.,]\d+)?)/);
  if (mAireTri) {
    const b = Number(mAireTri[1]!.replace(",", "."));
    const h = Number(mAireTri[2]!.replace(",", "."));
    return {
      resolu: true,
      famille: "aire",
      valeur: (b * h) / 2,
      unite: "u²",
      etapes: [
        `aire d'un triangle = base × hauteur ÷ 2`,
        `= ${formaterNombre(b)} × ${formaterNombre(h)} ÷ 2 = ${formaterNombre((b * h) / 2)}`,
      ],
    };
  }

  // 6. PÉRIMÈTRE — carré, rectangle, cercle.
  const mPerCarre = qs.match(/p[ée]rim[èe]tre\b[^.]*carr[ée][^.]*c[ôo]t[ée]\s*(?:de\s*|mesurant\s*)?(\d+(?:[.,]\d+)?)/);
  if (mPerCarre) {
    const c = Number(mPerCarre[1]!.replace(",", "."));
    return {
      resolu: true,
      famille: "perimetre",
      valeur: 4 * c,
      unite: "u",
      etapes: [
        `périmètre d'un carré = 4 × côté`,
        `= 4 × ${formaterNombre(c)} = ${formaterNombre(4 * c)}`,
      ],
    };
  }
  const mPerRect = qs.match(/p[ée]rim[èe]tre\b[^.]*rectangle[^.]*longueur\s*(?:de\s*)?(\d+(?:[.,]\d+)?)[^.]*largeur\s*(?:de\s*)?(\d+(?:[.,]\d+)?)/);
  if (mPerRect) {
    const L = Number(mPerRect[1]!.replace(",", "."));
    const l = Number(mPerRect[2]!.replace(",", "."));
    return {
      resolu: true,
      famille: "perimetre",
      valeur: 2 * (L + l),
      unite: "u",
      etapes: [
        `périmètre d'un rectangle = 2 × (longueur + largeur)`,
        `= 2 × (${formaterNombre(L)} + ${formaterNombre(l)}) = ${formaterNombre(2 * (L + l))}`,
      ],
    };
  }
  const mPerCercle = qs.match(/p[ée]rim[èe]tre\b[^.]*cercle[^.]*rayon\s*(?:de\s*|mesurant\s*)?(\d+(?:[.,]\d+)?)/);
  if (mPerCercle) {
    const r = Number(mPerCercle[1]!.replace(",", "."));
    const v = 2 * Math.PI * r;
    return {
      resolu: true,
      famille: "perimetre",
      valeur: v,
      unite: "u",
      etapes: [
        `périmètre d'un cercle = 2 × π × rayon`,
        `= 2 × π × ${formaterNombre(r)} = ${formaterNombre(v)} (π ≈ 3,141592)`,
      ],
    };
  }

  // 7. PYTHAGORE — hypoténuse depuis les deux catètes.
  const mPyth = qs.match(/hypot[ée]nuse\b[^.]*?(\d+(?:[.,]\d+)?)\s*(?:et|puis)\s*(\d+(?:[.,]\d+)?)/);
  if (mPyth) {
    const a = Number(mPyth[1]!.replace(",", "."));
    const b = Number(mPyth[2]!.replace(",", "."));
    const v = Math.sqrt(a * a + b * b);
    return {
      resolu: true,
      famille: "pythagore",
      valeur: v,
      unite: "u",
      etapes: [
        `hypoténuse = √(catète₁² + catète₂²)`,
        `= √(${formaterNombre(a)}² + ${formaterNombre(b)}²)`,
        `= √(${formaterNombre(a * a + b * b)})`,
        `= ${formaterNombre(v)}`,
      ],
    };
  }

  // 8. PARTAGE — « partage 120 entre 4 », « divise 120 par 4 ».
  const mPartage = qs.match(
    new RegExp(`(?:partag\\w*|divis\\w*|r[ée]partis?\\w*)\\s*${NB_RE}\\s*(?:entre|parmi|par|sur)\\s*${NB_RE}`),
  );
  if (mPartage) {
    const total = Number(mPartage[1]!.replace(",", "."));
    const parts = Number(mPartage[2]!.replace(",", "."));
    if (parts !== 0) {
      return {
        resolu: true,
        famille: "partage",
        valeur: total / parts,
        unite: "",
        etapes: [
          `partage de ${formaterNombre(total)} en ${formaterNombre(parts)} part(s)`,
          `= ${formaterNombre(total)} ÷ ${formaterNombre(parts)} = ${formaterNombre(total / parts)}`,
        ],
      };
    }
  }

  // 9. VITESSE — « 360 km en 4 h » (vitesse), « 90 km/h pendant 3 h » (distance).
  const mVitesse = qs.match(new RegExp(`${NB_RE}\\s*km\\s+en\\s+${NB_RE}\\s*h\\b`));
  if (mVitesse) {
    const d = Number(mVitesse[1]!.replace(",", "."));
    const t = Number(mVitesse[2]!.replace(",", "."));
    if (t !== 0) {
      return {
        resolu: true,
        famille: "vitesse",
        valeur: d / t,
        unite: "km/h",
        etapes: [
          `vitesse = distance ÷ temps`,
          `= ${formaterNombre(d)} km ÷ ${formaterNombre(t)} h = ${formaterNombre(d / t)} km/h`,
        ],
      };
    }
  }
  const mDistance = qs.match(new RegExp(`${NB_RE}\\s*km/?h\\s+(?:pendant|durant|de)\\s+${NB_RE}\\s*h\\b`));
  if (mDistance) {
    const v = Number(mDistance[1]!.replace(",", "."));
    const t = Number(mDistance[2]!.replace(",", "."));
    return {
      resolu: true,
      famille: "vitesse",
      valeur: v * t,
      unite: "km",
      etapes: [
        `distance = vitesse × temps`,
        `= ${formaterNombre(v)} km/h × ${formaterNombre(t)} h = ${formaterNombre(v * t)} km`,
      ],
    };
  }

  return NON_RESOLU;
}

/**
 * Formule la réponse française du compartiment — le résultat ET les étapes
 * (gen3 montre son raisonnement de calcul, pas seulement le chiffre).
 */
export function formuleReponse(r: ResultatCalcul): string {
  const unite = r.unite ? ` ${r.unite}` : "";
  const etapes = r.etapes.map((e, i) => `${i + 1}) ${e}`).join(" ");
  return `[Compartiment math] Résultat : ${formaterNombre(r.valeur ?? 0)}${unite}. Étapes du calcul : ${etapes}`;
}
