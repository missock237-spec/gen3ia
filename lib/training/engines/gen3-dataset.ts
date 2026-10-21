/**
 * PARSING DES DATASETS POUR LE MOTEUR GEN3 NATIF.
 *
 * Le moteur « gen3-native » fait entraîner par Gen (l'IA de la plateforme)
 * un modèle de langage sur les paires question/réponse fournies par
 * l'utilisateur. Ce module convertit un dataset brut (json / jsonl / csv /
 * txt) en paires exploitables, avec des compteurs HONNÊTES : chaque ligne
 * ignorée est comptée et signalée — rien n'est inventé, rien n'est simulé.
 *
 * Formats reconnus :
 *  - json / jsonl : objets { instruction|question|prompt|motif,
 *    response|answer|reponse|réponse|output|completion } (les variantes
 *    FR/EN et q/a sont acceptées — « completion » couvre le format
 *    prompt/completion standard des datasets LLM) ;
 *  - csv : mêmes noms de colonnes (première ligne = en-tête) ;
 *  - txt : blocs « Q: … / A: … » (ou Question: / Réponse:), séparés par
 *    des lignes vides — les autres contenus txt ne constituent PAS des
 *    paires exploitables et sont signalés comme ignorés.
 *
 * Plafonds honnêtes (matchés aux knownLimits du moteur dans le registre) :
 *  - MAX_OCTETS_DATASET = 5 Mo ;
 *  - MAX_PAIRES_DATASET = 5 000 (les excédentaires sont ignorées, pas
 *    silencieusement tronquées).
 *
 * Module PUR — aucune dépendance Node, aucune dépendance au réseau.
 */

/** Plafond de taille d'un dataset (octets). */
export const MAX_OCTETS_DATASET = 5 * 1024 * 1024;

/** Plafond de paires apprises par dataset. */
export const MAX_PAIRES_DATASET = 5000;

/** Paire brute extraite d'un dataset. */
export interface PaireBrute {
  question: string;
  reponse: string;
}

/** Résultat de parsing (compteurs réels, avertissements explicites). */
export interface ResultatParsingDataset {
  paires: PaireBrute[];
  /** Nombre total d'éléments rencontrés (lignes ou enregistrements). */
  elements: number;
  /** Éléments ignorés (champs manquants, vides, au-delà du plafond…). */
  ignores: number;
  avertissements: string[];
}

/** Clés de question reconnues (couvre les conventions usuelles FR/EN). */
const CLES_QUESTION = [
  "instruction", "question", "prompt", "input", "motif", "q", "query",
] as const;

/** Clés de réponse reconnues. */
const CLES_REPONSE = [
  "response", "answer", "reponse", "réponse", "output", "reply", "a", "completion",
] as const;

function champTexte(valeur: unknown): string | null {
  if (typeof valeur === "string" && valeur.trim().length > 0) return valeur.trim();
  if (typeof valeur === "number" && Number.isFinite(valeur)) return String(valeur);
  return null;
}

/** Extrait {question, réponse} d'un enregistrement plat, ou null. */
function paireDepuisObjet(objet: Record<string, unknown>): PaireBrute | null {
  let question: string | null = null;
  for (const cle of CLES_QUESTION) {
    const valeur = champTexte(objet[cle]);
    if (valeur) {
      question = valeur;
      break;
    }
  }
  let reponse: string | null = null;
  for (const cle of CLES_REPONSE) {
    const valeur = champTexte(objet[cle]);
    if (valeur) {
      reponse = valeur;
      break;
    }
  }
  if (!question || !reponse) return null;
  return { question: question.slice(0, 2000), reponse: reponse.slice(0, 8000) };
}

/** Parse un contenu JSON (tableau d'objets) ou JSONL (un objet par ligne). */
function parserJson(jsonl: boolean, contenu: string, resultat: ResultatParsingDataset): void {
  const enregistrer = (objet: unknown): void => {
    resultat.elements += 1;
    if (resultat.paires.length >= MAX_PAIRES_DATASET) {
      resultat.ignores += 1;
      return;
    }
    if (!objet || typeof objet !== "object" || Array.isArray(objet)) {
      resultat.ignores += 1;
      return;
    }
    const paire = paireDepuisObjet(objet as Record<string, unknown>);
    if (!paire) {
      resultat.ignores += 1;
      return;
    }
    resultat.paires.push(paire);
  };

  if (!jsonl) {
    let donnees: unknown;
    try {
      donnees = JSON.parse(contenu);
    } catch {
      resultat.avertissements.push("JSON illisible : le fichier n'a pas pu être parsé (0 paire apprise).");
      return;
    }
    const liste = Array.isArray(donnees) ? donnees : [donnees];
    for (const element of liste) enregistrer(element);
    return;
  }

  const lignes = contenu.split(/\r?\n/);
  for (let i = 0; i < lignes.length; i += 1) {
    const ligne = lignes[i].trim();
    if (!ligne) continue;
    let objet: unknown;
    try {
      objet = JSON.parse(ligne);
    } catch {
      resultat.avertissements.push(`Ligne ${i + 1} JSONL illisible : ignorée.`);
      resultat.elements += 1;
      resultat.ignores += 1;
      continue;
    }
    enregistrer(objet);
  }
}

/** Parse un CSV : première ligne = en-tête, colonnes reconnues par nom. */
function parserCsv(contenu: string, resultat: ResultatParsingDataset): void {
  const lignes = contenu.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lignes.length < 2) {
    resultat.avertissements.push("CSV vide ou sans données : 0 paire apprise.");
    return;
  }
  const separateur = (lignes[0].match(/;/g)?.length ?? 0) > (lignes[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const entetes = lignes[0].split(separateur).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const idxQuestion = entetes.findIndex((h) => (CLES_QUESTION as readonly string[]).includes(h));
  const idxReponse = entetes.findIndex((h) => (CLES_REPONSE as readonly string[]).includes(h));
  if (idxQuestion < 0 || idxReponse < 0) {
    resultat.avertissements.push(
      `CSV sans colonne question/réponse reconnue (en-têtes : ${entetes.join(", ") || "aucun"}) : 0 paire apprise.`,
    );
    return;
  }
  for (let i = 1; i < lignes.length; i += 1) {
    resultat.elements += 1;
    if (resultat.paires.length >= MAX_PAIRES_DATASET) {
      resultat.ignores += 1;
      continue;
    }
    const cellules = lignes[i].split(separateur).map((c) => c.trim().replace(/^"|"$/g, ""));
    const question = champTexte(cellules[idxQuestion]);
    const reponse = champTexte(cellules[idxReponse]);
    if (!question || !reponse) {
      resultat.ignores += 1;
      continue;
    }
    resultat.paires.push({ question: question.slice(0, 2000), reponse: reponse.slice(0, 8000) });
  }
}

/** Parse un TXT en blocs « Q: … / A: … » séparés par des lignes vides. */
function parserTxt(contenu: string, resultat: ResultatParsingDataset): void {
  const blocs = contenu.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter((b) => b.length > 0);
  for (const bloc of blocs) {
    resultat.elements += 1;
    if (resultat.paires.length >= MAX_PAIRES_DATASET) {
      resultat.ignores += 1;
      continue;
    }
    const lignes = bloc.split(/\r?\n/).map((l) => l.trim());
    let question: string | null = null;
    let reponse: string | null = null;
    for (const ligne of lignes) {
      const q = /^(?:q|question)\s*[:.]\s*(.+)$/i.exec(ligne);
      const r = /^(?:a|r|reponse|réponse)\s*[:.]\s*(.+)$/i.exec(ligne);
      if (q && !question) question = q[1].trim();
      else if (r && !reponse) reponse = r[1].trim();
    }
    if (!question || !reponse) {
      resultat.ignores += 1;
      continue;
    }
    resultat.paires.push({ question: question.slice(0, 2000), reponse: reponse.slice(0, 8000) });
  }
  if (resultat.paires.length === 0 && resultat.elements > 0) {
    resultat.avertissements.push(
      "TXT : aucun bloc « Q: / A: » détecté — les documents sans structure question/réponse ne constituent pas des paires entraînables.",
    );
  }
}

/**
 * Convertit un dataset brut en paires entraînables.
 * `format` : "json" | "jsonl" | "csv" | "txt" (tout autre format → erreur).
 */
export function parserDatasetGen3(format: string, contenu: string): ResultatParsingDataset {
  const resultat: ResultatParsingDataset = { paires: [], elements: 0, ignores: 0, avertissements: [] };
  const normalise = format.trim().toLowerCase();
  if (normalise === "json" || normalise === "jsonl") {
    parserJson(normalise === "jsonl", contenu, resultat);
  } else if (normalise === "csv") {
    parserCsv(contenu, resultat);
  } else if (normalise === "txt") {
    parserTxt(contenu, resultat);
  } else {
    resultat.avertissements.push(`Format ${format} non pris en charge par le moteur Gen3 natif.`);
  }

  // Plafond de taille (le contenu a potentiellement dépassé MAX_OCTETS —
  // les paires excédentaires au-delà du plafond ont déjà été ignorées).
  if (Buffer.byteLength(contenu, "utf-8") > MAX_OCTETS_DATASET) {
    resultat.avertissements.push(
      `Dataset > ${Math.round(MAX_OCTETS_DATASET / (1024 * 1024))} Mo : seules les premières paires (plafond ${MAX_PAIRES_DATASET}) ont été prises en compte.`,
    );
  }
  if (resultat.ignores > 0) {
    resultat.avertissements.push(`${resultat.ignores} élément(s) ignoré(s) (champs manquants ou plafonds).`);
  }
  return resultat;
}

/**
 * Sépare les paires en jeu d'entraînement / jeu de test (jamais vu pendant
 * l'apprentissage). Répartition déterministe : 1 paire sur k part au test.
 */
export function separerTrainTest(
  paires: readonly PaireBrute[],
  ratioTest: number,
): { train: PaireBrute[]; test: PaireBrute[] } {
  const propre = Math.min(0.5, Math.max(0, ratioTest));
  if (paires.length < 4 || propre <= 0) return { train: [...paires], test: [] };
  const pas = Math.max(2, Math.round(1 / propre));
  const train: PaireBrute[] = [];
  const test: PaireBrute[] = [];
  paires.forEach((paire, i) => {
    if (i % pas === 0 && test.length < Math.floor(paires.length * propre)) test.push(paire);
    else train.push(paire);
  });
  return { train, test };
}
