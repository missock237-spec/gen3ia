/**
 * Conversion HTML/XML → texte par MACHINE À ÉTATS (un seul passage).
 *
 * POURQUOI (audit de sécurité CodeQL — recommandation §4) : les chaînes de
 * regex du type `<script[\s\S]*?</script>` puis `<[^>]+>` puis décodage
 * d'entités sont démontrablement insuffisantes et soulèvent trois familles
 * d'alertes :
 *  - js/bad-tag-filter : `<scr<script>ipt>alert()</script>` traverse la
 *    regex paresseuse et laisse du balisage actif dans le texte extrait ;
 *  - js/incomplete-multi-character-sanitization : les séquences de
 *    plusieurs caractères (`&amp;lt;` → `&lt;` selon l'ordre des passes)
 *    ne sont neutralisées qu'en partie ;
 *  - js/double-escaping : un décodage par passes successives peut
 *    re-décoder ce que la passe précédente a déjà interprété.
 *
 * PRINCIPE : un parseur incrémental fidèle au comportement navigateur —
 *  - une `<` n'ouvre une balise QUE si elle est suivie de `[a-zA-Z/!?]`
 *    (sinon c'est du texte littéral — exactement ce que font les
 *    navigateurs, ce qui rend les évasions par balise imbriquée inertes) ;
 *  - les balises sont lues caractère par caractère en respectant les
 *    guillemets d'attributs (`<a title="a>b">` ne coupe pas la balise) ;
 *  - les éléments à contenu brut (script, style, noscript, head…) sont
 *    ignorés JUSQU'À leur balise fermante réelle, insensible à la casse ;
 *  - les entités sont décodées UNE SEULE FOIS, en place, avec une table
 *    finie (amp, lt, gt, quot, apos, nbsp + numériques décimal/hexa) —
 *    un `&` inconnu reste littéral, jamais ré-interprété ensuite ;
 *  - les balises de bloc ferment un paragraphe (`\n`), `<br>` aussi ;
 *  - les commentaires et CDATA sont ignorés entièrement.
 *
 * ZÉRO regex sur le chemin du contenu : la sortie ne peut plus contenir de
 * balisage actif issu d'une évasion, et chaque entrée est décodée
 * exactement une fois. 100 % testable en pur Node (voir html-text.test.ts).
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Éléments dont le contenu ne doit JAMAIS être extrait (contenu brut). */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript", "head", "template", "iframe", "object", "svg", "math"]);

export interface HtmlTextOptions {
  /**
   * Éléments dont la FERMETURE émet une fin de paragraphe (`\n`). Défaut :
   * le bloc HTML usuel (p, div, section, article, li, h1-h6, tr).
   */
  blockElements?: string[];
  /** Éléments dont la fermeture émet une tabulation (ex. `w:tab` DOCX). */
  tabElements?: string[];
  /**
   * Compacte les blancs (espaces/tabs/nouvelles lignes) en un espace unique.
   * Défaut : true. À false pour conserver les `\n` structurels émis.
   */
  collapseWhitespace?: boolean;
}

const DEFAULT_BLOCK = ["p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"];

const enum State {
  Text = 0,
  TagOpen = 1,
  Comment = 2,
  RawText = 3,
}

/** Décode une entité unique à partir de `input[start] === "&"`. Retourne [texte, longueur consommée]. */
function decodeEntity(input: string, start: number): [string, number] {
  const end = input.indexOf(";", start);
  if (end < 0 || end - start > 12) return ["&", 1];
  const name = input.slice(start + 1, end);
  if (!name) return ["&", 1];
  if (name[0] === "#") {
    const hex = name[1] === "x" || name[1] === "X";
    const digits = name.slice(hex ? 2 : 1);
    if (!digits || (hex && !/^[0-9a-fA-F]+$/.test(digits)) || (!hex && !/^\d+$/.test(digits))) return ["&", 1];
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) return ["&", 1];
    // Les contrôles C0/C1 ne passent jamais dans du texte extrait.
    if (code < 32 || (code >= 127 && code < 160)) return [" ", end - start + 1];
    return [String.fromCodePoint(code), end - start + 1];
  }
  const named = NAMED_ENTITIES[name.toLowerCase()];
  return named ? [named, end - start + 1] : ["&", 1];
}

/**
 * Convertit un document HTML/XML en texte lisible.
 * Complexité O(n), un passage, aucune regex sur le contenu.
 */
export function markupToText(input: string, options: HtmlTextOptions = {}): string {
  const blockElements = new Set((options.blockElements ?? DEFAULT_BLOCK).map((name) => name.toLowerCase()));
  const tabElements = new Set((options.tabElements ?? []).map((name) => name.toLowerCase()));
  const collapse = options.collapseWhitespace ?? true;

  const out: string[] = [];
  let state: State = State.Text;
  let rawElement = "";
  let tagName = "";
  let quote: string | null = null;
  let pendingBreak = false;

  const pushText = (text: string) => {
    if (!text) return;
    if (collapse) {
      out.push(text.replace(/[ \t\r\n]+/g, " "));
    } else {
      out.push(text);
    }
    pendingBreak = false;
  };
  const pushBreak = (kind: "\n" | "\t") => {
    if (collapse && kind === "\n") {
      if (!pendingBreak) {
        out.push("\n");
        pendingBreak = true;
      }
      return;
    }
    out.push(kind);
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (state === State.Comment) {
      if (char === ">" && input[i - 1] === "-" && input[i - 2] === "-") state = State.Text;
      continue;
    }

    if (state === State.RawText) {
      if (char === "<" && input[i + 1] === "/") {
        const close = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(input.slice(i));
        if (close && close[1].toLowerCase() === rawElement) {
          state = State.Text;
          i += close[0].length - 1;
          continue;
        }
      }
      continue;
    }

    if (state === State.TagOpen) {
      // Le nom est déjà résolu à l'entrée de la balise : ici on ne gère que
      // guillemets d'attributs et fermeture — « <scr ipt> » reste « scr »
      // (un espace termine un nom d'élément, comme chez les navigateurs).
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ">") {
        state = State.Text;
        if (tagName === "br") pushBreak("\n");
        if (tabElements.has(tagName)) pushBreak("\t");
        continue;
      }
      continue;
    }

    // État Text.
    if (char === "<") {
      const next = input[i + 1];
      if (next === "!") {
        if (input.startsWith("<!--", i)) {
          state = State.Comment;
          i += 3;
          continue;
        }
        if (/^<!\[CDATA\[/i.test(input.slice(i, i + 9))) {
          const end = input.indexOf("]]>", i + 9);
          i = end >= 0 ? end + 2 : input.length - 1;
          continue;
        }
        // <!DOCTYPE …> : ignoré jusqu'au `>`.
        const end = input.indexOf(">", i);
        i = end >= 0 ? end : input.length - 1;
        continue;
      }
      if (next === "?") {
        const end = input.indexOf("?>", i);
        i = end >= 0 ? end + 1 : input.length - 1;
        continue;
      }
      if (!/[a-zA-Z/]/.test(next ?? "")) {
        // Une `<` orpheline est du TEXTE (comportement navigateur) — c'est
        // ce qui neutralise `<scr<script>ipt>` et les `<` partiellement échappés.
        out.push("&lt;");
        pendingBreak = false;
        continue;
      }
      const closing = next === "/";
      const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(input.slice(i));
      const name = nameMatch?.[1]?.toLowerCase() ?? "";
      if (closing && (blockElements.has(name) || name === "w:p")) pushBreak("\n");
      if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
        state = State.RawText;
        rawElement = name;
        continue;
      }
      state = State.TagOpen;
      // Le nom est FIGÉ ici : l'espace (et tout caractère non-constituant)
      // termine un nom d'élément — jamais de concaténation d'attributs.
      tagName = name;
      continue;
    }
    if (char === "&") {
      const [decoded, consumed] = decodeEntity(input, i);
      // Un seul décodage, en place — le résultat n'est PAS re-scanné.
      pushText(decoded);
      i += consumed - 1;
      continue;
    }
    pushText(char);
  }

  let text = out.join("");
  if (collapse) text = text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return text;
}

/** HTML → texte plat (extraits, aperçus de recherche, ouvertures de pages). */
export function htmlToPlainText(html: string, options: HtmlTextOptions = {}): string {
  return markupToText(html, { collapseWhitespace: true, ...options });
}
