/**
 * Découpe de phrases FRANÇAISES pour le TTS Live Voix (Task 110-a).
 *
 * Objectif : alimenter le TTS phrase par phrase (le client peut commencer à
 * jouer le premier audio pendant que la suite se synthétise). La découpe doit
 *  - respecter les abréviations courantes (M., Mme, Mlle, Dr, Pr…) qui
 *    contiennent un point SANS marquer une fin de phrase ;
 *  - ne pas couper à l'intérieur d'un nombre décimal (3.14) ;
 *  - couper sur . ! ? … et les sauts de ligne ;
 *  - REGROUPER les phrases courtes : le TTS est plus naturel et moins coûteux
 *    par appel sur des chunks remplis — cible ~200 caractères, plafond dur
 *    240 caractères par chunk (une phrase isolée plus longue reste entière :
 *    jamais de coupe au milieu d'une phrase).
 *
 * Module PUR (aucune dépendance) : réutilisable côté client pour l'aperçu.
 */

/** Plafond dur d'un chunk TTS (caractères). */
const MAX_CHUNK_CHARS = 240;

/** Cible de remplissage d'un chunk (caractères) — au-delà, on émet. */
const TARGET_CHUNK_CHARS = 200;

/** Abréviations FR courantes dont le point ne finit PAS une phrase. */
const ABBREVIATIONS = new Set([
  "m", "mr", "mme", "mlle", "dr", "pr", "me", "vve", "st", "ste", "sr", "jr",
  "av", "art", "fig", "vol", "fasc", "p", "pp", "sq", "sqq", "t", "ch",
  "etc", "ex", "ca", "cf", "n°", "no", "b.p", "s.a.r.l", "s.a.s", "eurl",
]);

/** Terminaisons de phrase reconnues. */
const TERMINATORS = ".!?…";

/** Fermetures collées au terminator qui restent dans la phrase (… ! »). */
const TRAILING_CLOSERS = "»\")']";

/** Test d'un caractère « lettre/chiffre » FR (accents inclus). */
function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}'’-]/u.test(char);
}

/**
 * True si le point situé à `dotIndex` NE termine PAS la phrase :
 * décimal (3.14), initiale (J.), ou abréviation connue (M., Mme, Dr…).
 */
function isAbbreviationDot(source: string, dotIndex: number): boolean {
  const previous = source[dotIndex - 1];
  const next = source[dotIndex + 1];
  // Décimal : chiffre.point.chiffre (3.14, 1.000).
  if (previous && next && /\d/.test(previous) && /\d/.test(next)) return true;

  let start = dotIndex - 1;
  while (start >= 0 && isWordChar(source[start])) start -= 1;
  const word = source.slice(start + 1, dotIndex).toLowerCase();
  if (!word) return false;
  // Initiale suivie d'un espace (Paul J. Dupont) : jamais une fin de phrase.
  if (word.length === 1) return true;
  return ABBREVIATIONS.has(word);
}

/** Découpe brute en phrases (abréviations respectées, sauts de ligne inclus). */
function rawSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const isTerminator = char ? TERMINATORS.includes(char) : false;
    const isNewline = char === "\n";
    if (!isTerminator && !isNewline) continue;
    if (isTerminator && char === "." && isAbbreviationDot(text, index)) continue;

    // Consomme les terminators consécutifs (« !! », « ?! ») et les fermetures
    // collées (« mot. ») : tout reste DANS la phrase terminée.
    let end = index + 1;
    while (end < text.length && TERMINATORS.includes(text[end]!)) end += 1;
    while (end < text.length && TRAILING_CLOSERS.includes(text[end]!)) end += 1;

    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);

    // Repart après les espaces : le retour chariot / l'alinéa ouvre une
    // nouvelle phrase (les titres sur leur propre ligne sont séparés).
    start = end;
    while (start < text.length && /\s/.test(text[start]!)) start += 1;
    index = start - 1;
  }

  if (start < text.length) {
    const rest = text.slice(start).trim();
    if (rest) sentences.push(rest);
  }
  return sentences;
}

/**
 * Regroupe les phrases courtes : remplissage jusqu'à la cible (~200 chars)
 * sans jamais dépasser le plafond (240 chars). Une phrase plus longue que le
 * plafond part SEULE (jamais de coupe intra-phrase).
 */
function groupIntoChunks(sentences: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    const merged = `${current} ${sentence}`;
    if (current.length >= TARGET_CHUNK_CHARS || merged.length > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = merged;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Découpe un texte (réponse d'agent) en chunks TTS prêts à synthétiser :
 * phrases FR (abréviations respectées) regroupées par ~200–240 caractères.
 * Texte vide / blanc → tableau vide.
 */
export function splitSentences(text: string): string[] {
  const normalized = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  return groupIntoChunks(rawSentences(normalized));
}
