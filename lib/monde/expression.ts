/**
 * Parseur d'expressions mathématiques sûr — zéro `eval`, zéro `Function`.
 *
 * Le Monde doit résoudre des équations fournies PAR L'UTILISATEUR
 * (« y' = -2*x*y + sin(x) »). Exécuter du texte arbitraire serait une
 * faille critique : ce module tokenise puis analyse l'expression en un
 * AST typé, évalué par interprétation pure. Tout symbole inconnu,
 * tout prototype invalide, toute construction douteuse est REFUSÉE à
 * l'analyse — le pire qu'une expression hostile puisse faire est de
 * renvoyer NaN ou de lever une `ErreurExpression`.
 *
 * Grammaire (Pratt, précédences usuelles) :
 *   expr    := comparaison
 *   primaire:= NOMBRE | VARIABLE | CONSTANTE | fnc '(' args ')' | '(' expr ')'
 *   puissance droite-associative, unaire − et +, produits/sommes gauches.
 */

/** Erreur d'analyse ou d'évaluation d'expression utilisateur. */
export class ErreurExpression extends Error {}

type TypeJeton =
  | "nombre"
  | "variable"
  | "fonction"
  | "operateur"
  | "parenthese"
  | "virgule";

interface Jeton {
  type: TypeJeton;
  texte: string;
  /** Valeur numérique pour les nombres. */
  valeur?: number;
  position: number;
}

const FONCTIONS: ReadonlyMap<string, (...args: number[]) => number> = new Map([
  ["sin", Math.sin],
  ["cos", Math.cos],
  ["tan", Math.tan],
  ["asin", Math.asin],
  ["acos", Math.acos],
  ["atan", Math.atan],
  ["sinh", Math.sinh],
  ["cosh", Math.cosh],
  ["tanh", Math.tanh],
  ["exp", Math.exp],
  ["ln", Math.log],
  ["log", Math.log10],
  ["sqrt", Math.sqrt],
  ["abs", Math.abs],
  ["sign", Math.sign],
  ["min", Math.min],
  ["max", Math.max],
  ["atan2", Math.atan2],
  ["floor", Math.floor],
  ["ceil", Math.ceil],
]);

const ARITES: ReadonlyMap<string, number> = new Map([
  ["min", 2],
  ["max", 2],
  ["atan2", 2],
]);

const CONSTANTES: ReadonlyMap<string, number> = new Map([
  ["pi", Math.PI],
  ["π", Math.PI],
  ["e", Math.E],
  ["tau", Math.PI * 2],
]);

const VARIABLES_AUTORISEES = new Set(["x", "y", "t", "z"]);

function tokeniser(source: string): Jeton[] {
  const jetons: Jeton[] = [];
  let i = 0;
  while (i < source.length) {
    const caractere = source[i];
    if (caractere === " " || caractere === "\t" || caractere === "\n") {
      i += 1;
      continue;
    }
    // Nombres (décimaux et notation scientifique 1.2e-3).
    if (/[0-9]/.test(caractere) || (caractere === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const debut = i;
      while (i < source.length && /[0-9.]/.test(source[i])) i += 1;
      if (source[i] === "e" || source[i] === "E") {
        const sauvegarde = i;
        i += 1;
        if (source[i] === "+" || source[i] === "-") i += 1;
        if (/[0-9]/.test(source[i] ?? "")) {
          while (i < source.length && /[0-9]/.test(source[i])) i += 1;
        } else {
          i = sauvegarde; // le « e » n'était pas un exposant : expression usurpée.
        }
      }
      const texte = source.slice(debut, i);
      const valeur = Number(texte);
      if (!Number.isFinite(valeur)) {
        throw new ErreurExpression(`Nombre invalide « ${texte} ».`);
      }
      jetons.push({ type: "nombre", texte, valeur, position: debut });
      continue;
    }
    // Identifiants : variables, constantes, fonctions.
    if (/[a-zA-Zπ_]/.test(caractere)) {
      const debut = i;
      while (i < source.length && /[a-zA-Z0-9π_]/.test(source[i])) i += 1;
      const texte = source.slice(debut, i).toLowerCase();
      if (FONCTIONS.has(texte)) {
        jetons.push({ type: "fonction", texte, position: debut });
      } else if (CONSTANTES.has(texte)) {
        jetons.push({
          type: "nombre",
          texte,
          valeur: CONSTANTES.get(texte),
          position: debut,
        });
      } else if (VARIABLES_AUTORISEES.has(texte)) {
        jetons.push({ type: "variable", texte, position: debut });
      } else {
        throw new ErreurExpression(
          `Symbole inconnu « ${texte} » — variables autorisées : x, y, t, z.`,
        );
      }
      continue;
    }
    if ("+-*/^%".includes(caractere)) {
      jetons.push({ type: "operateur", texte: caractere, position: i });
      i += 1;
      continue;
    }
    if (caractere === "(" || caractere === ")") {
      jetons.push({ type: "parenthese", texte: caractere, position: i });
      i += 1;
      continue;
    }
    if (caractere === ",") {
      jetons.push({ type: "virgule", texte: ",", position: i });
      i += 1;
      continue;
    }
    throw new ErreurExpression(`Caractère interdit « ${caractere} ».`);
  }
  return jetons;
}

type Noeud =
  | { genre: "nombre"; valeur: number }
  | { genre: "variable"; nom: string }
  | { genre: "unaire"; operateur: string; operand: Noeud }
  | { genre: "binaire"; operateur: string; gauche: Noeud; droite: Noeud }
  | { genre: "appel"; nom: string; arguments: Noeud[] };

/** Précédences : % = 2, ^ = 4 (droite-associatif), * / = 3, + - = 2. */
function precedence(operateur: string): number {
  switch (operateur) {
    case "^":
      return 4;
    case "*":
    case "/":
    case "%":
      return 3;
    case "+":
    case "-":
      return 2;
    default:
      return 0;
  }
}

function estDroiteAssociatif(operateur: string): boolean {
  return operateur === "^";
}

class Analyseur {
  private index = 0;
  constructor(private readonly jetons: Jeton[]) {}

  private regarder(): Jeton | undefined {
    return this.jetons[this.index];
  }

  analyserTout(): Noeud {
    const noeud = this.analyserExpression(0);
    if (this.index < this.jetons.length) {
      throw new ErreurExpression(
        `Jeton inattendu « ${this.jetons[this.index].texte} » après l'expression.`,
      );
    }
    return noeud;
  }

  private analyserExpression(minPrecedence: number): Noeud {
    let gauche = this.analyserPrimaire();
    for (;;) {
      const jeton = this.regarder();
      if (!jeton || jeton.type !== "operateur") break;
      const prec = precedence(jeton.texte);
      if (prec < minPrecedence) break;
      this.index += 1;
      const suivante = estDroiteAssociatif(jeton.texte) ? prec : prec + 1;
      const droite = this.analyserExpression(suivante);
      gauche = { genre: "binaire", operateur: jeton.texte, gauche, droite };
    }
    return gauche;
  }

  private analyserPrimaire(): Noeud {
    const jeton = this.regarder();
    if (!jeton) throw new ErreurExpression("Expression incomplète.");
    this.index += 1;

    if (jeton.type === "nombre") return { genre: "nombre", valeur: jeton.valeur ?? 0 };

    if (jeton.type === "variable") return { genre: "variable", nom: jeton.texte };

    if (jeton.type === "fonction") {
      const parenthese = this.regarder();
      if (!parenthese || parenthese.texte !== "(") {
        throw new ErreurExpression(`« ${jeton.texte} » doit être suivi de parenthèses.`);
      }
      this.index += 1;
      const args: Noeud[] = [];
      if (this.regarder()?.texte !== ")") {
        args.push(this.analyserExpression(0));
        while (this.regarder()?.texte === ",") {
          this.index += 1;
          args.push(this.analyserExpression(0));
        }
      }
      const fermante = this.regarder();
      if (!fermante || fermante.texte !== ")") {
        throw new ErreurExpression(`Parenthèse fermante manquante pour ${jeton.texte}().`);
      }
      this.index += 1;
      const arite = ARITES.get(jeton.texte) ?? 1;
      if (args.length !== arite) {
        throw new ErreurExpression(
          `${jeton.texte}() attend ${arite} argument(s), reçu ${args.length}.`,
        );
      }
      return { genre: "appel", nom: jeton.texte, arguments: args };
    }

    if (jeton.texte === "(") {
      const interne = this.analyserExpression(0);
      const fermante = this.regarder();
      if (!fermante || fermante.texte !== ")") {
        throw new ErreurExpression("Parenthèse fermante manquante.");
      }
      this.index += 1;
      return interne;
    }

    if (jeton.texte === "-" || jeton.texte === "+") {
      const operand = this.analyserExpression(
        jeton.texte === "-" ? 5 : 6,
      );
      return jeton.texte === "-"
        ? { genre: "unaire", operateur: "-", operand }
        : operand;
    }

    throw new ErreurExpression(`Jeton inattendu « ${jeton.texte} ».`);
  }
}

function evaluerNoeud(noeud: Noeud, env: Record<string, number>): number {
  switch (noeud.genre) {
    case "nombre":
      return noeud.valeur;
    case "variable": {
      const valeur = env[noeud.nom];
      return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : NaN;
    }
    case "unaire":
      return -evaluerNoeud(noeud.operand, env);
    case "binaire": {
      const a = evaluerNoeud(noeud.gauche, env);
      const b = evaluerNoeud(noeud.droite, env);
      switch (noeud.operateur) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "^":
          return Math.pow(a, b);
        default:
          throw new ErreurExpression(`Opérateur inconnu « ${noeud.operateur} ».`);
      }
    }
    case "appel": {
      const fnc = FONCTIONS.get(noeud.nom);
      if (!fnc) throw new ErreurExpression(`Fonction inconnue « ${noeud.nom} ».`);
      const args = noeud.arguments.map((a) => evaluerNoeud(a, env));
      return fnc(...args);
    }
  }
}

/** Une expression compilée : réutilisable, évaluable des milliers de fois. */
export interface ExpressionCompilee {
  /** Évalue l'expression avec l'environnement fourni (x, y, t, z). */
  evaluer(env: Record<string, number>): number;
  /** Représentation lisible (diagnostique). */
  source: string;
}

/**
 * Compile une expression mathématique utilisateur en évaluateur sûr.
 * Lève `ErreurExpression` si l'expression est invalide ou suspecte.
 */
export function compilerExpression(source: string): ExpressionCompilee {
  const jetons = tokeniser(source);
  if (jetons.length === 0) throw new ErreurExpression("Expression vide.");
  if (jetons.length > 512) {
    throw new ErreurExpression("Expression trop longue (512 jetons maximum).");
  }
  const ast = new Analyseur(jetons).analyserTout();
  return {
    evaluer(env: Record<string, number>): number {
      return evaluerNoeud(ast, env);
    },
    source: source.trim(),
  };
}

/** Analyse sans lever : renvoie null au lieu d'erreur (détection d'intention). */
export function tenterCompiler(
  source: string,
): ExpressionCompilee | null {
  try {
    return compilerExpression(source);
  } catch {
    return null;
  }
}
