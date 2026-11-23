/**
 * MOTEUR DE CALCUL EXACT — solveur arithmétique DÉTERMINISTE du cerveau
 * Gen3 (v5, Job 478451).
 *
 * Le cerveau Gen3 répond aux calculs par EXACTITUDE (aucune IA externe) :
 * analyseur lexical + parser à descente récursive SANS eval() :
 *   - opérateurs + - × x * / ÷ % ^ (parenthèses) ;
 *   - pourcentages : « 20% de 150 », « 150 + 10% » ;
 *   - racines : sqrt(81), √81 ;
 *   - mots : « calcule », « compute », « combien font », « how much is ».
 *
 * Sortie : résultat EXACT + étapes intermédiaires quand le calcul est composé.
 * Module PUR : zéro I/O — testable unitairement (moteur-calcul.test.ts).
 */

const NOMBRE_MAX = 1e15;

interface Jeton {
  type: "nombre" | "operateur" | "parenthese" | "fonction";
  valeur: string;
}

/** Étape de calcul (journal honnête des opérations). */
export interface EtapeCalcul {
  expression: string;
  resultat: number;
}

export interface SolutionCalcul {
  resultat: number;
  affichage: string;
  etapes: EtapeCalcul[];
}

/** Normalise FR/EN sans casser les nombres. */
function normaliserExpression(texte: string): string {
  return texte
    .replace(/×|·|✕/g, "*")
    .replace(/÷/g, "/")
    .replace(/−|–|—/g, "-")
    .replace(/\b(sqrt|racine carre de|racine carrée de|racine de)\b/gi, "sqrt")
    .replace(/√\s*/g, "sqrt")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenise une expression arithmétique (nombres, opérateurs, parens, sqrt). */
function tokeniser(expr: string): Jeton[] | null {
  const jetons: Jeton[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === " ") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const valeur = expr.slice(i, j);
      if ((valeur.match(/\./g) ?? []).length > 1) return null;
      jetons.push({ type: "nombre", valeur });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      jetons.push({ type: "operateur", valeur: c });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      jetons.push({ type: "parenthese", valeur: c });
      i++;
      continue;
    }
    if (expr.slice(i, i + 4).toLowerCase() === "sqrt") {
      jetons.push({ type: "fonction", valeur: "sqrt" });
      i += 4;
      continue;
    }
    return null; // caractère inconnu → pas une expression pure
  }
  return jetons;
}

/**
 * Parser à descente récursive :
 *   expr   := terme (('+'|'-') terme)*
 *   terme  := facteur (('*'|'/'|'%') facteur)*
 *   facteur := base ('^' facteur)?
 *   base   := nombre | '(' expr ')' | 'sqrt' base | ('-'|'+') base
 */
class Analyseur {
  private pos = 0;
  private etapes: EtapeCalcul[] = [];

  constructor(private readonly jetons: Jeton[]) {}

  analyser(): { valeur: number; etapes: EtapeCalcul[] } | null {
    try {
      const valeur = this.expr();
      if (this.pos !== this.jetons.length) return null;
      if (!Number.isFinite(valeur) || Math.abs(valeur) > NOMBRE_MAX) return null;
      return { valeur, etapes: this.etapes };
    } catch {
      return null;
    }
  }

  private regarder(): Jeton | null {
    return this.jetons[this.pos] ?? null;
  }

  private consommer(): Jeton {
    const j = this.jetons[this.pos];
    if (!j) throw new Error("fin d'expression");
    this.pos++;
    return j;
  }

  private expr(): number {
    let gauche = this.terme();
    while (true) {
      const j = this.regarder();
      if (j && j.type === "operateur" && (j.valeur === "+" || j.valeur === "-")) {
        this.consommer();
        const droite = this.terme();
        const resultat = j.valeur === "+" ? gauche + droite : gauche - droite;
        this.etapes.push({ expression: `${gauche} ${j.valeur} ${droite}`, resultat });
        gauche = resultat;
      } else break;
    }
    return gauche;
  }

  private terme(): number {
    let gauche = this.facteur();
    while (true) {
      const j = this.regarder();
      if (j && j.type === "operateur" && (j.valeur === "*" || j.valeur === "/" || j.valeur === "%")) {
        this.consommer();
        const droite = this.facteur();
        if ((j.valeur === "/" || j.valeur === "%") && droite === 0) throw new Error("division par zéro");
        const resultat = j.valeur === "*" ? gauche * droite : j.valeur === "/" ? gauche / droite : gauche % droite;
        this.etapes.push({ expression: `${gauche} ${j.valeur === "*" ? "×" : j.valeur === "/" ? "÷" : "mod"} ${droite}`, resultat });
        gauche = resultat;
      } else break;
    }
    return gauche;
  }

  private facteur(): number {
    const base = this.base();
    const j = this.regarder();
    if (j && j.type === "operateur" && j.valeur === "^") {
      this.consommer();
      const exposant = this.facteur();
      const resultat = Math.pow(base, exposant);
      if (!Number.isFinite(resultat) || Math.abs(resultat) > NOMBRE_MAX) throw new Error("hors bornes");
      this.etapes.push({ expression: `${base} ^ ${exposant}`, resultat });
      return resultat;
    }
    return base;
  }

  private base(): number {
    const j = this.regarder();
    if (!j) throw new Error("fin inattendue");
    if (j.type === "nombre") {
      this.consommer();
      const v = Number(j.valeur);
      if (!Number.isFinite(v)) throw new Error("nombre invalide");
      return v;
    }
    if (j.type === "parenthese" && j.valeur === "(") {
      this.consommer();
      const v = this.expr();
      const ferme = this.consommer();
      if (ferme.valeur !== ")") throw new Error("parenthèse non fermée");
      return v;
    }
    if (j.type === "fonction" && j.valeur === "sqrt") {
      this.consommer();
      const v = this.base();
      if (v < 0) throw new Error("racine négative");
      const resultat = Math.sqrt(v);
      this.etapes.push({ expression: `sqrt(${v})`, resultat });
      return resultat;
    }
    if (j.type === "operateur" && (j.valeur === "-" || j.valeur === "+")) {
      this.consommer();
      const v = this.base();
      return j.valeur === "-" ? -v : v;
    }
    throw new Error("jeton inattendu");
  }
}

/** Pourcentages FR/EN : « X% de Y », « Y + X% », « X percent of Y ». */
function resoudrePourcentages(prompt: string): SolutionCalcul | null {
  const p1 = prompt.match(/(\d+(?:[.,]\d+)?)\s*(?:%|pour ?cents?|percent)\s*(?:de|of)\s*(\d+(?:[.,]\d+)?)/i);
  if (p1) {
    const pourcent = Number(p1[1].replace(",", "."));
    const base = Number(p1[2].replace(",", "."));
    if (!Number.isFinite(pourcent) || !Number.isFinite(base)) return null;
    const resultat = (pourcent / 100) * base;
    return {
      resultat,
      affichage: `${pourcent} % de ${base} = ${base} × ${pourcent}/100 = ${formater(resultat)}`,
      etapes: [{ expression: `${base} × ${pourcent}/100`, resultat }],
    };
  }
  const p2 = prompt.match(/(\d+(?:[.,]\d+)?)\s*([+\-])\s*(\d+(?:[.,]\d+)?)\s*(?:%|pour ?cents?|percent)/i);
  if (p2) {
    const base = Number(p2[1].replace(",", "."));
    const signe = p2[2];
    const pourcent = Number(p2[3].replace(",", "."));
    const delta = (pourcent / 100) * base;
    const resultat = signe === "+" ? base + delta : base - delta;
    return {
      resultat,
      affichage: `${base} ${signe} ${pourcent}% → ${signe === "+" ? "augmentation" : "réduction"} de ${formater(delta)} → résultat : ${formater(resultat)}`,
      etapes: [
        { expression: `${pourcent}/100 × ${base}`, resultat: delta },
        { expression: `${base} ${signe} ${formater(delta)}`, resultat },
      ],
    };
  }
  return null;
}

function formater(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e6) / 1e6);
}

/** Détecte une expression arithmétique pure dans le prompt. */
function extraireExpression(prompt: string): string | null {
  const nettoye = normaliserExpression(prompt)
    // Retire les mots de commande FR/EN autour de l'expression (le parser
    // n'accepte que nombres/opérateurs/parenthèses/sqrt).
    .replace(/\b(calcule|calculez|compute|calculer|resoudre|resolve|combien font|combien fait|how much is|how much are|what is|what does)\b/gi, " ")
    .replace(/\b(cela|cette expression|this expression|font|fait|equals|egal|égal|resultat|résultat|give|me|the|result|of)\b/gi, " ");
  // L'expression = la plus longue sous-chaîne ne contenant que des caractères arithmétiques
  const morceaux = nettoye.match(/[\d.+\-*/%^()sqrt√ ]{3,}/g);
  if (!morceaux) return null;
  let meilleure: string | null = null;
  for (const m of morceaux) {
    const t = m.trim();
    if (
      /\d/.test(t) &&
      (/[+\-*/%^]/.test(t) || /sqrt/i.test(t)) &&
      (!meilleure || t.length > meilleure.length)
    ) {
      meilleure = t;
    }
  }
  return meilleure;
}

/**
 * Tente de répondre EXACTEMENT à une demande de calcul.
 * Retourne null si le prompt n'est pas un calcul (le cerveau passe alors
 * au cortex langagier).
 */
export function resoudreCalcul(prompt: string): string | null {
  const pourcent = resoudrePourcentages(prompt);
  if (pourcent) return pourcent.affichage;

  const expression = extraireExpression(prompt);
  if (!expression) return null;
  const jetons = tokeniser(expression);
  if (!jetons || jetons.length < 3) return null;
  const analyse = new Analyseur(jetons).analyser();
  if (!analyse) return null;
  if (analyse.etapes.length === 0) return null;
  const etapesTxt = analyse.etapes
    .slice(0, 6)
    .map((e, i) => `Étape ${i + 1} : ${e.expression} = ${formater(e.resultat)}`)
    .join(" ; ");
  return `${etapesTxt}. Résultat final : ${formater(analyse.valeur)}`;
}
