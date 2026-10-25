/**
 * CHUNKING SÉMANTIQUE — découpe le texte en fragments alignés sur la
 * STRUCTURE réelle du document (titres, paragraphes, phrases) au lieu d'une
 * fenêtre de caractères aveugle : les extraits récupérés en recherche
 * vectorielle deviennent des unités de sens complètes, ce qui améliore
 * directement la pertinence du RAG.
 *
 * Stratégie (déterministe, sans dépendance) :
 *  1. Segmenter en BLOCS : un titre (markdown `#…` ou ligne courte sans
 *     point final) ouvre un nouveau bloc ; les lignes vides séparent les
 *     paragraphes ;
 *  2. Empaqueter les paragraphes gloutonnement dans des chunks ≤ maxCharacters
 *     (un paragraphe n'est JAMAIS coupé tant qu'il tient dans le budget) ;
 *  3. Un paragraphe trop long est découpé sur les FRONTIÈRES DE PHRASES
 *     (jamais au milieu d'un mot) ;
 *  4. CHEVAUCHEMENT contrôlé : chaque chunk reprend la fin du précédent
 *     (dernières phrases ≤ overlap) pour préserver le contexte de bord.
 */

export interface TextChunk {
  index: number;

  text: string;

  start: number;

  end: number;
}

export interface ChunkOptions {
  maxCharacters?: number;

  overlap?: number;
}

/** Un paragraphe brut (texte + offsets dans le document d'origine). */
interface Paragraphe {
  texte: string;
  debut: number;
  fin: number;
}

/**
 * Découpe le texte en paragraphes structurés :
 *  - une ligne de TITRE (markdown `#{1,6} ` ou ligne < 80 caractères sans
 *    ponctuation finale) force une nouvelle section ;
 *  - les lignes vides séparent les paragraphes.
 * Les offsets d'origine sont préservés (start/end exacts des chunks).
 */
function segmenterParagraphes(texte: string): Paragraphe[] {
  const paragraphes: Paragraphe[] = [];
  const lignes = texte.split("\n");
  let curseur = 0;
  let courant: string[] = [];
  let debutCourant = 0;
  let sectionOuverte = false;

  const estTitre = (ligne: string): boolean => {
    const trim = ligne.trim();
    if (!trim) return false;
    if (/^#{1,6}\s+\S/.test(trim)) return true;
    // Ligne courte, sans point final, suivie de contenu : titre probable.
    return trim.length < 80 && !/[.!?;:]$/.test(trim) && !trim.startsWith("-") && !trim.startsWith("*");
  };

  const vider = (finExclusive: number): void => {
    const texte = courant.join("\n").trim();
    if (texte) {
      paragraphes.push({
        texte,
        debut: debutCourant,
        fin: Math.max(debutCourant + 1, finExclusive),
      });
    }
    courant = [];
  };

  for (const ligne of lignes) {
    const debutLigne = curseur;
    const finLigne = curseur + ligne.length;
    curseur = finLigne + 1; // +1 pour le \n consommé par split

    if (!ligne.trim()) {
      // Ligne vide : sépare les paragraphes.
      vider(debutLigne);
      debutCourant = curseur;
      sectionOuverte = false;
      continue;
    }

    const titre = estTitre(ligne);
    if (titre || sectionOuverte) {
      // Un titre (ou la première ligne d'une nouvelle section) ouvre un bloc.
      vider(debutLigne);
      debutCourant = debutLigne;
      sectionOuverte = false;
    }
    if (titre) sectionOuverte = false;
    courant.push(ligne);
  }
  vider(texte.length);

  return paragraphes;
}

/** Découpe un texte en phrases (frontières ., !, ?, retour ligne). */
function segmenterPhrases(texte: string): string[] {
  const morceaux = texte
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return morceaux.length > 0 ? morceaux : [texte.trim()].filter(Boolean);
}

/** Découpe un paragraphe trop long par phrases, en respectant le budget. */
function découperLong(
  paragraphe: Paragraphe,
  maxCharacters: number,
  overlap: number,
  sortie: TextChunk[],
): void {
  const phrases = segmenterPhrases(paragraphe.texte);
  let tampon: string[] = [];
  let tailleTampon = 0;

  const viderTampon = (): void => {
    if (tampon.length === 0) return;
    const texte = tampon.join(" ");
    const debutRelatif = paragraphe.texte.indexOf(texte);
    const debut = paragraphe.debut + (debutRelatif >= 0 ? debutRelatif : 0);
    sortie.push({
      index: sortie.length,
      text: texte,
      start: debut,
      end: debut + texte.length,
    });
    // Chevauchement : reprend les dernières phrases dans le budget.
    const queue: string[] = [];
    let tailleQueue = 0;
    for (let i = tampon.length - 1; i >= 0; i--) {
      const phrase = tampon[i] as string;
      if (tailleQueue + phrase.length + 1 > overlap) break;
      queue.unshift(phrase);
      tailleQueue += phrase.length + 1;
    }
    tampon = queue;
    tailleTampon = tailleQueue;
  };

  for (const phrase of phrases) {
    if (phrase.length > maxCharacters) {
      // Phrase monstre (tableau, minified) : découpe dure de secours,
      // uniquement ici — jamais pour le texte normal.
      viderTampon();
      for (let i = 0; i < phrase.length; i += maxCharacters) {
        const morceau = phrase.slice(i, i + maxCharacters);
        const debutRelatif = paragraphe.texte.indexOf(morceau);
        const debut = paragraphe.debut + (debutRelatif >= 0 ? debutRelatif : 0);
        sortie.push({
          index: sortie.length,
          text: morceau,
          start: debut,
          end: debut + morceau.length,
        });
      }
      continue;
    }
    if (tailleTampon + phrase.length + 1 > maxCharacters) viderTampon();
    tampon.push(phrase);
    tailleTampon += phrase.length + 1;
  }
  viderTampon();
}

export function chunkText(
  text: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const maxCharacters =
    options.maxCharacters ?? 4000;

  const overlap =
    options.overlap ?? 400;

  if (
    maxCharacters <= overlap
  ) {
    throw new Error(
      "maxCharacters must be greater than overlap",
    );
  }

  const texte = text ?? "";
  if (!texte.trim()) return [];

  // 1) Segmentation structurée en paragraphes (titres = nouvelles sections).
  const paragraphes = segmenterParagraphes(texte);
  if (paragraphes.length === 0) return [];

  // 2) Empaquetage glouton des paragraphes → chunks complets.
  const chunks: TextChunk[] = [];
  let empaquetés: Paragraphe[] = [];
  let taillePaquet = 0;

  const viderPaquet = (): void => {
    if (empaquetés.length === 0) return;
    const textePaquet = empaquetés.map((p) => p.texte).join("\n\n");
    const debut = empaquetés[0]!.debut;
    chunks.push({
      index: chunks.length,
      text: textePaquet,
      start: debut,
      end: debut + textePaquet.length,
    });
    empaquetés = [];
    taillePaquet = 0;
  };

  for (const paragraphe of paragraphes) {
    if (paragraphe.texte.length > maxCharacters) {
      // 3) Paragraphe géant → découpe par phrases (frontières propres).
      viderPaquet();
      découperLong(paragraphe, maxCharacters, overlap, chunks);
      continue;
    }
    if (taillePaquet + paragraphe.texte.length + 2 > maxCharacters) {
      viderPaquet();
    }
    empaquetés.push(paragraphe);
    taillePaquet += paragraphe.texte.length + 2;
  }
  viderPaquet();

  // 4) Chevauchement contrôlé : chaque chunk (sauf le premier de chaque
  //    empaquetage) reprend la fin du chunk précédent — contexte de bord
  //    préservé pour la recherche vectorielle.
  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const précédent = chunks[i - 1]!;
      const courant = chunks[i]!;
      // Uniquement si les chunks se suivent réellement dans le document
      // (sinon ils proviennent de sections différentes : pas de recouvrement).
      if (courant.start - précédent.end > 4) continue;
      const queue = précédent.text.slice(-overlap);
      const pointCoupure = queue.search(/[\s]/);
      const recouvrement = pointCoupure > 0 ? queue.slice(pointCoupure + 1) : queue;
      if (recouvrement && courant.text.length + recouvrement.length <= maxCharacters + overlap) {
        chunks[i] = {
          ...courant,
          text: `${recouvrement}\n${courant.text}`,
        };
      }
    }
  }

  return chunks;
}
