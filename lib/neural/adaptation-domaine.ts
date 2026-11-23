/**
 * ADAPTATION DE DOMAINE DYNAMIQUE — la garantie « n'importe quel domaine »
 * sans réentraînement complet (demande utilisateur : gen3 doit travailler
 * dans n'importe quel domaine ou situation, DEPUIS son système neuronal et
 * SA mémoire).
 *
 * Problème : la couche des 18 domaines est entraînée (détection lexicale
 * sur mots-clés réels des datasets). Un domaine NOUVEAU — non couvert par
 * les 18 pools — n'est pas reconnu : la réponse perd son ancrage de domaine
 * et retombe sur la composition générique.
 *
 * Solution : quand la détection lexicale échoue (carence), le moteur FORME
 * un domaine dynamique depuis les mots informatifs réels du message, le
 * mémorise (registre du moteur — la mémoire de travail de l'adaptation ;
 * les échanges restent par ailleurs consolidés dans l'hippocampe), et le
 * RECONNAIT aux tours suivants en le renforçant. La reconnaissance de
 * domaine devient évolutive : chaque requête hors-catalogue apprend son
 * domaine au cerveau au lieu de le perdre.
 *
 * HONNÊTETÉ :
 *  - la détection lexicale des 18 domaines PRIME toujours (catalogue
 *    entraîné = source de vérité) ; l'adaptation ne couvre que la carence ;
 *  - un domaine dynamique est appris seulement si le message porte AU
 *    MOINS DEUX mots informatifs — « bonjour » n'apprend rien ;
 *  - le score du domaine dynamique reflète le RENFORCEMENT réel (chaque
 *    reconnaissance le renforce), pas une précision fantôme.
 *
 * Module PUR (aucune I/O) : testable unitairement, dépend de rien.
 */

/** Un domaine appris à la volée par le moteur (hors catalogue entraîné). */
export interface DomaineDynamiqueGen3 {
  /** Identifiant interne, préfixe dédié pour ne jamais heurter les 18 pools. */
  label: string;
  /** Nom lisible (français) construit depuis les mots réels du message. */
  nom: string;
  /** Mots-clés informatifs retenus — la signature du domaine. */
  motsCles: string[];
  /** Renforcement cumulé : 1 à la formation, +1 à chaque reconnaissance. */
  score: number;
  /** Horodatage de l'apprentissage (ms epoch). */
  apprisA: number;
}

/** Format de détection compatible avec la couche des 18 domaines (engine). */
export interface DetectionAdaptee {
  label: string;
  nom: string;
  nomEn: string | null;
  score: number;
  source: "lexical" | "dynamique";
}

/** Seuil de signature : au moins DEUX mots-clés partagés pour reconnaître. */
export const ADAPTATION_MIN_MOTS_COMMUNS = 2;
/** Mots informatifs retenus au maximum comme signature d'un domaine appris. */
export const ADAPTATION_MAX_MOTS_CLES = 5;
/** Longueur minimale d'un mot informatif (les outils et articles sont exclus). */
export const ADAPTATION_TAILLE_MIN_MOT = 3;
/**
 * STRUCTURE DE DEMANDE : un domaine n'est appris que si le message ressemble
 * à une vraie demande (longueur suffisante OU marqueur d'intention) — le
 * bruit lexical pur (« xyzzy qwerty flurb ») ne doit JAMAIS apprendre un
 * domaine inventé.
 */
export const ADAPTATION_MOTS_TOTALS_MIN = 6;
export const MARQUEURS_INTENTION = [
  "je veux", "j'aimerais", "je souhaite", "comment", "pourquoi", "fais", "faire",
  "crée", "cree", "créer", "analyse", "explique", "rédige", "redige", "code",
  "prépare", "prepare", "donne", "aide", "peux-tu", "lance", "construis",
  "écris", "ecris", "résume", "resume", "trouve", "cherche", "traduis",
  "compose", "conçois", "concois", "propose", "optimise", "corrige", "montre",
];

/** Mots outils français écartés (informatifs uniquement — même esprit que le pont). */
const MOTS_OUTILS = new Set([
  "avec", "sans", "pour", "dans", "cette", "tout", "tous", "toute", "toutes",
  "être", "avoir", "fait", "faire", "comme", "mais", "donc", "alors",
  "plus", "moins", "très", "bien", "peut", "peux", "veux", "dois", "doit",
  "quel", "quelle", "quels", "quelles", "ceci", "cela", "leur", "notre",
  "votre", "chaque", "après", "avant", "entre", "chez", "puis", "ainsi",
  "dont", "rien", "autre", "aussi", "bonjour", "merci", "s'il", "plait",
  "les", "des", "une", "mon", "ton", "son", "ses", "qui", "que", "quoi",
  "sur", "par", "aux", "est", "sont", "vas", "vais", "type", "style",
]);

/** Mots informatifs réels du message (ordre de première apparition). */
export function motsInformatifs(texte: string): string[] {
  const vus = new Set<string>();
  const resultats: string[] = [];
  for (const brut of texte.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüç0-9]+/)) {
    const mot = brut.replace(/^(s')/,"");
    if (
      mot.length < ADAPTATION_TAILLE_MIN_MOT ||
      MOTS_OUTILS.has(mot) ||
      /^\d+$/.test(mot) ||
      vus.has(mot)
    ) {
      continue;
    }
    vus.add(mot);
    resultats.push(mot);
  }
  return resultats;
}

/** Carence : la couche entraînée n'a rien reconnu pour ce message. */
export function carenceDomaine(detection: DetectionAdaptee | null): boolean {
  return detection === null;
}

/**
 * FORMATION : le message devient un domaine appris (signature = mots
 * informatifs réels, jusqu'à 5). Deux gardes honnêtes :
 *  · au moins DEUX mots informatifs — « bonjour » n'apprend rien ;
 *  · une STRUCTURE DE DEMANDE réelle — au moins 6 mots au total OU un
 *    marqueur d'intention (« je veux », « analyse », « ? »…) — le bruit
 *    lexical pur n'invente jamais un domaine.
 * Retourne null si le message ne définit pas un domaine honnête.
 */
export function formerDomaineDynamique(
  texte: string,
  maintenantMs: number,
  compteur: number,
): DomaineDynamiqueGen3 | null {
  const mots = motsInformatifs(texte);
  if (mots.length < ADAPTATION_MIN_MOTS_COMMUNS) return null;
  const bas = texte.toLowerCase();
  const structureDemande =
    bas.split(/\s+/).filter(Boolean).length >= ADAPTATION_MOTS_TOTALS_MIN ||
    MARQUEURS_INTENTION.some((marqueur) => bas.includes(marqueur)) ||
    bas.includes("?");
  if (!structureDemande) return null;
  const signature = mots.slice(0, ADAPTATION_MAX_MOTS_CLES);
  const nom = signature
    .slice(0, 2)
    .map((mot) => mot.charAt(0).toUpperCase() + mot.slice(1))
    .join(" ");
  return {
    label: `DOM_DYN_${String(compteur).padStart(3, "0")}`,
    nom,
    motsCles: signature,
    score: 1,
    apprisA: maintenantMs,
  };
}

/**
 * RECONNAISSANCE : un tour suivant dont les mots recoupent la signature
 * d'un domaine déjà appris (≥ 2 mots communs) est reconnu DYNAMIQUEMENT —
 * le moteur a appris ce domaine et le retrouve sans réentraînement.
 * En cas de plusieurs candidats : le plus renforcé (score, puis récence).
 */
export function reconnaitreDomaineDynamique(
  texte: string,
  registre: Map<string, DomaineDynamiqueGen3>,
): DetectionAdaptee | null {
  const mots = new Set(motsInformatifs(texte));
  if (mots.size === 0 || registre.size === 0) return null;
  let meilleur: { domaine: DomaineDynamiqueGen3; communs: string[] } | null = null;
  for (const domaine of registre.values()) {
    const communs = domaine.motsCles.filter((motCle) => mots.has(motCle));
    if (communs.length < ADAPTATION_MIN_MOTS_COMMUNS) continue;
    if (
      meilleur === null ||
      domaine.score > meilleur.domaine.score ||
      (domaine.score === meilleur.domaine.score && domaine.apprisA > meilleur.domaine.apprisA)
    ) {
      meilleur = { domaine, communs };
    }
  }
  if (!meilleur) return null;
  return {
    label: meilleur.domaine.label,
    nom: meilleur.domaine.nom,
    nomEn: null,
    score: meilleur.domaine.score,
    source: "dynamique",
  };
}

/** RENFORCEMENT : chaque reconnaissance d'un domaine appris le consolide. */
export function renforcerDomaineDynamique(domaine: DomaineDynamiqueGen3): DomaineDynamiqueGen3 {
  return { ...domaine, score: domaine.score + 1 };
}

/** Phrase honnête de l'apprentissage (transparence dans la réponse). */
export function phraseApprentissageDomaine(nom: string): string {
  return `(Nouveau domaine « ${nom} » appris depuis ta demande et mémorisé : je le reconnaîtrai aux prochains échanges. Formule ta demande précise sur ce sujet.)`;
}
