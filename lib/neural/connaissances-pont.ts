/**
 * PONT CONNAISSANCES → RÉPONSE (demande utilisateur : « entraîne l'IA de
 * telle sorte qu'elle maîtrise le concept que l'utilisateur lui fournit »).
 *
 * PROBLÈME CORRIGÉ : les fragments de la base de connaissances (documents
 * indexés par l'utilisateur) étaient injectés dans le SYSTEM PROMPT — mais
 * le moteur neural local compose sa réponse depuis le DERNIER MESSAGE seul
 * (cortex + décodeur) : les connaissances ingérées n'atteignaient JAMAIS le
 * texte de la réponse. Le RAG était donc mort en sortie, même quand la
 * recherche trouvait le bon fragment.
 *
 * SOLUTION : ce module est appelé par le moteur neural AVANT le repli
 * cortex/décodeur. Il relit les fragments réellement recherchés pour CE
 * tour (déjà sélectionnés par pertinence vectorielle + score ≥ 0.3 côté
 * lib/knowledge/chat-context), mesure leur recouvrement lexical avec la
 * question, et — si un fragment répond — compose une réponse CITÉE avec sa
 * source documentaire. Zéro invention : le texte cité est mot pour mot le
 * fragment indexé ; si rien ne correspond assez, la fonction retourne
 * null et la chaîne classique (cortex/décodeur) prend le relais.
 *
 * Module PUR (aucune I/O) : testable unitairement, dépend de rien.
 */

import type { CompositionReponse } from "./engine";

/** Nombre maximal de fragments cités dans une réponse composée. */
export const PONT_MAX_FRAGMENTS = 2;

/**
 * Seuils d'appariement : un fragment est retenu si au moins 2 mots
 * informatifs de la question s'y retrouvent, ou si le recouvrement
 * relatif atteint 50 % (question à un ou deux mots-clés).
 */
export const PONT_MIN_MOTS_COMMUNS = 2;
export const PONT_MIN_RECOUVREMENT = 0.5;

/** Mots outils français écartés du calcul (informatifs uniquement). */
const MOTS_OUTILS = new Set([
  "avec", "sans", "pour", "dans", "cette", "tout", "tous", "toute", "toutes",
  "être", "avoir", "fait", "faire", "comme", "mais", "donc", "alors",
  "plus", "moins", "très", "bien", "peut", "peux", "veux", "dois", "doit",
  "quel", "quelle", "quels", "quelles", "est-ce", "qu'est", "ceci", "cela",
  "leurs", "notre", "votre", "chaque", "après", "avant", "entre", "chez",
  "puis", "ainsi", "dont", "leur", "mien", "tien", "rien", "autre", "aussi",
]);

/** Normalise : minuscules + accents retirés. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Mots informatifs d'une phrase (≥ 4 caractères, hors mots outils). */
export function motsInformatifs(texte: string): string[] {
  const vus = new Set<string>();
  for (const mot of normaliser(texte).split(/[^a-z0-9]+/)) {
    if (mot.length < 4 || MOTS_OUTILS.has(mot)) continue;
    vus.add(mot);
  }
  return [...vus];
}

export interface FragmentConnaissance {
  documentId: string;
  chunkIndex: number;
  score: number;
  texte: string;
  /** "knowledge" = base de connaissances projet ; "fichier-importe" = pièce
   *  jointe réelle du tour (loadImportedFilesContext). */
  origine?: "knowledge" | "fichier-importe";
}

/**
 * Relit les fragments du contexte knowledge (format produit par
 * buildKnowledgeContext) : `- [document X, fragment Y, score Z]\n<texte>`.
 * RÉPARATION ARTEFACT (Job 478451) : le contexte peut AUSSI contenir les
 * blocs du contenu RÉEL des fichiers importés (loadImportedFilesContext,
 * uni au canal knowledge par le chat) — en-tête `Fichier importé « nom »
 * (...) :` suivi du texte converti. Chaque fichier est un fragment du tour
 * (score 1 : l'utilisateur l'a joint DANS ce message — pertinence maximale).
 * Tolérant : un bloc mal formé est ignoré (jamais de crash pour un
 * contexte inattendu).
 */
export function parserFragmentsConnaissances(knowledgeContext: string): FragmentConnaissance[] {
  const fragments: FragmentConnaissance[] = [];
  const lignes = knowledgeContext.split("\n");
  const commenceBlocKnowledge = (ligne: string) => ligne.startsWith("- [document ");
  const enTeteFichier = (ligne: string) =>
    /^(?:Fichier importé|Fichier importe) « (.+?) » \([^)]*\) :\s*$/.exec(ligne);
  const estDebutBloc = (ligne: string) => commenceBlocKnowledge(ligne) || enTeteFichier(ligne) !== null;
  for (let index = 0; index < lignes.length; index += 1) {
    const ligne = lignes[index];
    if (commenceBlocKnowledge(ligne)) {
      const match = /^- \[document ([^\],]+), fragment (\d+)(?:, score ([\d.]+))?\]\s*$/.exec(ligne);
      if (!match) continue;
      // Le texte du fragment : les lignes suivantes jusqu'au prochain bloc.
      const texte: string[] = [];
      let suite = index + 1;
      while (suite < lignes.length && !estDebutBloc(lignes[suite])) {
        texte.push(lignes[suite]);
        suite += 1;
      }
      const contenu = texte.join("\n").trim();
      if (contenu.length < 20) continue; // fragment vide/étron : inutilisable
      fragments.push({
        documentId: match[1],
        chunkIndex: Number.parseInt(match[2], 10) || 0,
        score: match[3] ? Number.parseFloat(match[3]) : 0,
        texte: contenu,
        origine: "knowledge",
      });
      index = suite - 1; // la boucle externe reprend au prochain bloc
    } else {
      const match = enTeteFichier(ligne);
      if (!match) continue;
      const texte: string[] = [];
      let suite = index + 1;
      while (suite < lignes.length && !estDebutBloc(lignes[suite])) {
        texte.push(lignes[suite]);
        suite += 1;
      }
      const contenu = texte.join("\n").replace(/\n*---\s*$/, "").trim();
      if (contenu.length < 20) continue; // fragment vide/étron : inutilisable
      // Note de NON-charge (métadonnées seules) : jamais citée comme contenu
      // — le pont n'invente pas, il ignore et laisse le repli parler.
      if (/^(contenu non chargé|contenu non charge|\(aucun contenu texte\))/.test(contenu)) continue;
      fragments.push({
        documentId: match[1],
        chunkIndex: 0,
        score: 1, // fichier joint DANS ce message : pertinence maximale
        texte: contenu,
        origine: "fichier-importe",
      });
      index = suite - 1;
    }
  }
  return fragments;
}

/** Recouvrement lexical d'un fragment avec la question (0 → 1). */
function recouvrement(motsQuestion: string[], motsFragment: Set<string>): { communs: number; relatif: number } {
  if (motsQuestion.length === 0) return { communs: 0, relatif: 0 };
  let communs = 0;
  for (const mot of motsQuestion) {
    if (motsFragment.has(mot)) communs += 1;
  }
  return { communs, relatif: communs / motsQuestion.length };
}

/** Tronque une citation proprement (mot entier). */
function citer(texte: string, max = 700): string {
  const brut = texte.trim();
  if (brut.length <= max) return brut;
  const coupe = brut.slice(0, max);
  const dernierEspace = coupe.lastIndexOf(" ");
  return `${(dernierEspace > max * 0.6 ? coupe.slice(0, dernierEspace) : coupe).trimEnd()}…`;
}

/**
 * Compose une réponse APPUYÉE SUR LES DOCUMENTS de l'utilisateur quand un
 * fragment répond à la question. Retourne null sinon (le moteur retombe
 * sur cortex/décodeur — refus honnête plutôt qu'invention).
 */
export function composerDepuisConnaissances(
  question: string,
  knowledgeContext: string,
): CompositionReponse | null {
  const contexte = knowledgeContext?.trim();
  if (!contexte || !question?.trim()) return null;

  const motsQuestion = motsInformatifs(question);
  if (motsQuestion.length === 0) return null;

  const fragments = parserFragmentsConnaissances(contexte);
  if (fragments.length === 0) return null;

  const classes = fragments
    .map((fragment) => ({
      fragment,
      ...recouvrement(motsQuestion, new Set(motsInformatifs(fragment.texte))),
    }))
    .filter(({ communs, relatif }) => communs >= PONT_MIN_MOTS_COMMUNS || relatif >= PONT_MIN_RECOUVREMENT)
    .sort((a, b) => (b.relatif - a.relatif) || (b.fragment.score - a.fragment.score));

  if (classes.length === 0) return null;

  // Un seul bloc par document (le meilleur fragment) — au plus 2 documents.
  const parDocument = new Map<string, (typeof classes)[number]>();
  for (const entree of classes) {
    if (parDocument.has(entree.fragment.documentId)) continue;
    parDocument.set(entree.fragment.documentId, entree);
    if (parDocument.size >= PONT_MAX_FRAGMENTS) break;
  }

  const blocs = [...parDocument.values()].map(({ fragment }) =>
    fragment.origine === "fichier-importe"
      ? `« ${citer(fragment.texte)} »\n— Source : votre fichier importé « ${fragment.documentId} »`
      : `« ${citer(fragment.texte)} »\n— Source : document ${fragment.documentId}, fragment ${fragment.chunkIndex}`,
  );

  const avecFichier = [...parDocument.values()].some(({ fragment }) => fragment.origine === "fichier-importe");
  const avecKnowledge = [...parDocument.values()].some(({ fragment }) => fragment.origine !== "fichier-importe");
  const titre = avecFichier && avecKnowledge
    ? "D'après vos documents et vos fichiers joints :"
    : avecFichier
      ? "D'après le contenu RÉEL de votre fichier joint :"
      : "D'après vos documents (base de connaissances) :";

  const texte =
    blocs.length === 1
      ? `${titre}\n\n${blocs[0]}`
      : `${titre}\n\n${blocs.join("\n\n")}`;

  const meilleur = classes[0];
  return {
    texte,
    source: "connaissances_utilisateur",
    scoreAppariement: Number.parseFloat((meilleur.relatif || meilleur.fragment.score).toFixed(2)),
  };
}
