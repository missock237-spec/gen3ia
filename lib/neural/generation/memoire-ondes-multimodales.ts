/**
 * MÉMOIRE ONDES MULTIMODALES — espace combinatoire ADRESSABLE de plus de
 * 5 milliards d'échantillons bruts UNIQUES, porté en CODE SOURCE (même
 * mécanique que memoire-domaines-graines.ts : la mémoire est le générateur,
 * pas un fichier de données).
 *
 * Garantie de NON-DUPLICATION : l'index N est décodé en radices mixtes
 * (une case par dimension) — la bijection index → tuple garantit que deux
 * indices distincts diffèrent sur au moins une dimension, donc sur au moins
 * un mot du texte généré. Sans doublon PAR CONSTRUCTION, jusqu'à
 * TAILLE_ESPACE_ONDES_MULTIMODAL = 5 665 359 360 échantillons.
 *
 * Répartition de l'espace :
 *   analyse_multimodale :        20×14×12×8×2  =          53 760
 *   voix_parole :          24×12×8×3×10×5×2  =         691 200
 *   video_realiste :   30×30×16×5×4×4×2      =       2 304 000
 *   generation_image : 32×24×24×16×10×8×6×5×4×2 = 5 662 310 400
 *
 * HONNÊTETÉ : ces échantillons sont SYNTHÉTIQUES (grammaires métier —
 * briefs photoréalistes, briefs voix, storyboards, qualifications
 * d'artefacts), pas des données humaines curées : c'est le même statut que
 * les graines it.113. Chaque sortie porte sa limite honnête. Ils servent
 * l'entraînement EOD (source ondes) et la matérialisation JSONL via
 * scripts/generer-ondes-multimodaux.ts.
 *
 * Module PUR — aucune dépendance Node, entièrement déterministe.
 */

/** Échantillon généré (texte + domaine pour EOD ; instruction/sortie pour le schéma v4). */
export interface UniteOndesMultimodale {
  readonly domaine: string;
  readonly langue: string;
  /** Texte porteur des ondes (injecté dans le cortex par EOD). */
  readonly texte: string;
  readonly instruction: string;
  readonly sortie: string;
}

/** Tailles de dimensions (chaque liste est interne-unique ; listes adjacentes disjointes). */
const ARTEFACTS = ["capture d'écran de tableau de bord", "photo d'appareil fissuré", "enregistrement de réunion", "clip vidéo de 3 secondes", "facture scannée", "graphique en barres", "photo de plat cuisiné", "scan de contrat", "audio de podcast", "vidéo de surveillance", "maquette d'interface", "relevé bancaire scanné", "photo d'enseigne", "enregistrement d'appel", "panneau de signalisation", "capture de terminal", "photo d'objet ancien", "vidéo d'atelier", "audio de chant", "photo aérienne de parcelle"];
const DEFAUTS = ["légende illisible", "flou de mouvement", "incliné de 4 degrés", "sous-exposé", "bruit de fond constant", "chevauchement de locuteurs", "tampon recouvrant une zone", "pixelisation marquée", "reflets parasites", "saturation ponctuelle", "bord tronqué", "contraste insuffisant", "échelle absente", "couleurs décalées"];
const CONTEXTES = ["demande client", "audit interne", "support utilisateur", "préparation de livraison", "constat d'assurance", "archivage documentaire", "revue de qualité", "assistance à distance", "préparation de facturation", "enquête d'incidents", "documentation produit", "contrôle de conformité"];
const LIVRABLES = ["description structurée", "transcription horodatée", "plan de correction", "rapport de qualification", "extraction de champs", "résumé d'artefact", "liste de questions de clarification", "recommandation d'étapes"];

const USAGES_VOIX = ["voix off de documentaire", "message d'accueil d'assistance", "annonce de gare routière", "guide d'audiomusée", "chapitre d'audiobook", "bande-annonce d'application", "message de serveur vocal", "podcast d'introduction", "consigne de sécurité", "lecture de conte", "narration de reportage", "répondeur personnalisé", "annonce d'école", "guide touristique", "capsule pédagogique", "menu téléphonique", "annonce de match", "méditation guidée", "récit pour enfants", "flash d'information", "tutoriel pas à pas", "annonce de mariage", "souhaits d'anniversaire", "note sonore de bas de page"];
const REGISTRES = ["posé et chaleureux", "dynamique et souriant", "solenne et lent", "complice et bas", "clair et cristallin", "grave et rassurant", "neutre professionnel", "énergique radiophonique", "doux nocturne", "ferme pédagogique", "espiègle et léger", "émotion contenu"];
const DEBITS = ["très lent 120 mots/minute", "lent 140 mots/minute", "modéré 160 mots/minute", "naturel 170 mots/minute", "soutenu 190 mots/minute", "rapide 210 mots/minute", "très rapide 230 mots/minute", "variable avec pauses marquées"];
const MOTEURS_VOIX = ["f5", "kokoro", "f5 avec référence vocale"];
const SEGMENTS = ["une phrase", "deux phrases", "un paragraphe court", "trois paragraphes", "une liste de consignes", "un dialogue à deux voix", "un monologue narratif", "un dialogue téléphonique", "une énumération chiffrée", "une conclusion"];
const LONGUEURS = ["moins de 10 secondes", "15 secondes", "30 secondes", "une minute", "trois minutes"];

const MOUVEMENTS = ["travelling avant lent", "travelling latéral", "panoramique horizontal", "zoom avant progressif", "plan fixe", "plan fixe légèrement tremblé", "grue ascendante", "drone avançant", "drone en recul", "orbite lente", "suivi de sujet", "contre-plongée montante", "plongée descendante", "travelling arrière", "dolly avant serré", "balancement doux", "panoramique vertical", "arc de 90 degrés", "arc de 180 degrés", "approche par la gauche", "approche par la droite", "rotation lente du socle", "zoom arrière révélant", "montée en altitude", "descente en altitude", "travelling avant rapide", "arrêt sur image final", "départ à l'arrêt", "glissement latéral doux", "oscillation de marche"];
const SCENES = ["vague déferlant sur sable noir", "espresso versé dans une tasse en verre", "rue de ville sous la pluie", "fleur s'ouvrant en macro", "village côtier à l'heure dorée", "feu de bois qui crépite", "nuages d'orage en formation", "pirogue glissant sur le fleuve", "mains pétrissant la pâte", "poussière soulevée par le vent", "tissus colorés au vent", "cascade dans la forêt", "marché qui se monte à l'aube", "lampe à pétrole qui s'allume", "orage sur la savane", "fumée d'encens montant", "clavier tapé en gros plan", "visage éclairé par l'écran", "bétail traversant un gué", "train qui arrive en gare", "vélo dans une ruelle", "pêcheur lançant son filet", "sablier qui s'écoule", "flamme de chandelle vacillant", "volets s'ouvrant sur la mer", "café versé dans un verre", "brouillard roulant sur la colline", "lucioles dans la nuit", "pinceau traçant sur la toile", "charrette sur la piste rouge"];
const LUMIERES_VIDEO = ["lumière du matin dorée", "contre-jour de crépuscule", "néons sur asphalte mouillé", "éclairage studio sur fond noir", "lumière de bougie", "éclair d'orage", "soleil zénithal", "bleu de l'heure bleue", "lueur d'écran", "halo de lampadaire", "reflets d'eau", "lumière traversante de fenêtre", "braises rougeoyantes", "clair de lune argenté", "spot de chantier", "aube brumeuse"];
const DUREES = ["2 secondes", "3 secondes", "4 secondes", "5 secondes", "6 secondes"];
const RESOLUTIONS = ["480x288", "576x320", "704x448", "1024x576"];

const SUJETS_IMAGE = ["un chef qui flambe un dessert", "une potière façonnant un vase", "une pêcheuse au lancer", "un astronome sous son télescope", "une danseuse en mouvement", "un forgeron frappant le fer", "une tisserande au métier", "un apiculteur voilé", "un enfant courant dans une flaque", "un vieux pêcheur raccommodant son filet", "une vendeuse de tissus colorés", "un cycliste en plein effort", "un berger et son troupeau", "une calligraphe à l'encre noire", "un mécanicien penché sur un moteur", "une sage-femme souriante", "un sculpteur d'ébène", "une marchande d'ananas", "un joueur de kora", "une fileuse de coton", "un maçon posant des briques", "une liseuse sous un manguier", "un pêcheur en pirogue", "une boulangère sortant le pain", "un peintre muraliste", "un guide de brousse", "une institutrice au tableau noir", "un maraîcher arrosant sa parcelle", "un plongeur ajustant son masque", "une vendeuse d'épices en tas", "une récolteuse de cacao", "un charretier et son âne"];
const LIEUX_IMAGE = ["un marché de quartier", "une rive de fleuve au matin", "une cour de maison en terre", "un chantier de case", "une piste latéritique", "un atelier de menuiserie", "une savane dorée", "un port de pêche animé", "une rizière inondée", "un carrefour de village", "une école sous les arbres", "un champ de mil à maturité", "une corniche face à l'océan", "une cour d'école en récréation", "un garage de quartier", "une boutique de rue", "un chemin de montagne", "une plage de sable noir", "une zone artisanale", "un jardin tropical", "une gare routière vibrante", "une terrasse ombragée", "un pont sur le fleuve", "une place du marché au bétail"];
const AMBIANCES = ["brume légère", "chaleur de midi", "fin d'après-midi dorée", "orage imminent", "fraîcheur de l'aube", "poussière soulevée", "calme après la pluie", "vent de harmattan", "ambiance de fête locale", "silence de pleine nature", "effervescence commerciale", "recueillement tranquille", "humeur espiègle", "gravité solennelle", "gaieté populaire", "mélancolie douce", "tension du match", "concentration intense", "joie de la moisson", "attente paisible", "frénésie du marché", "quiétude du soir", "élan du départ", "atmosphère de veillée"];
const LUMIERES_IMAGE = ["soleil rasant à l'aube", "contre-jour doux", "lumière zénithale dure", "ombre portée d'auvent", "lumière de fin de journée", "ciel couvert diffus", "éclair d'orage", "lueur de lampe tempête", "reflets d'eau mouvants", "lumière de bougie", "première lumière bleue", "soleil filtré par la poussière", "flash frontal", "lueur d'écran", "éclat de fourneau", "halo de lampadaire"];
const OPTIQUES = ["24 mm f/4", "35 mm f/2", "50 mm f/1.4", "85 mm f/1.8", "100 mm macro f/2.8", "135 mm f/2", "70-200 mm à 135 mm f/4", "28 mm f/2.8", "180 mm f/2.8", "18 mm grand-angle f/3.5"];
const CADRAGES = ["plan large environnemental", "plan moyen hauteur des yeux", "gros plan sur les mains", "plan américain", "contre-plongée marquée", "plongée légère", "portrait de trois quarts", "plan d'ensemble symétrique"];
const FILMS = ["Kodak Portra 400", "Fuji Velvia 50", "Ilford HP5 en couleur chaude", "Cinestill 800T", "Kodachrome 64", "Agfa Vista 200"];
const FORMATS = ["1024x1024", "1024x768", "768x1024", "1152x896", "896x1152"];
const VARIANTES = ["rendu brut sans retouche", "rendu avec grain renforcé", "rendu à contraste doux", "rendu à saturation naturelle"];
const LANGUES = ["fr", "en"];

const produit = (dims: readonly number[]): number => dims.reduce((a, b) => a * b, 1);

export const DIMENSIONS_ANALYSE = [ARTEFACTS.length, DEFAUTS.length, CONTEXTES.length, LIVRABLES.length, LANGUES.length] as const;
export const DIMENSIONS_VOIX = [USAGES_VOIX.length, REGISTRES.length, DEBITS.length, MOTEURS_VOIX.length, SEGMENTS.length, LONGUEURS.length, LANGUES.length] as const;
export const DIMENSIONS_VIDEO = [MOUVEMENTS.length, SCENES.length, LUMIERES_VIDEO.length, DUREES.length, RESOLUTIONS.length, VARIANTES.length, LANGUES.length] as const;
export const DIMENSIONS_IMAGE = [SUJETS_IMAGE.length, LIEUX_IMAGE.length, AMBIANCES.length, LUMIERES_IMAGE.length, OPTIQUES.length, CADRAGES.length, FILMS.length, FORMATS.length, VARIANTES.length, LANGUES.length] as const;

export const ESPACE_ANALYSE_MULTIMODALE = produit(DIMENSIONS_ANALYSE);
export const ESPACE_VOIX_PAROLE = produit(DIMENSIONS_VOIX);
export const ESPACE_VIDEO_REALISTE = produit(DIMENSIONS_VIDEO);
export const ESPACE_GENERATION_IMAGE = produit(DIMENSIONS_IMAGE);

/** Offset de chaque domaine dans l'espace global (ordre : analyse, voix, vidéo, image). */
export const OFFSETS_DOMAINES = {
  analyse_multimodale: 0,
  voix_parole: ESPACE_ANALYSE_MULTIMODALE,
  video_realiste: ESPACE_ANALYSE_MULTIMODALE + ESPACE_VOIX_PAROLE,
  generation_image: ESPACE_ANALYSE_MULTIMODALE + ESPACE_VOIX_PAROLE + ESPACE_VIDEO_REALISTE,
} as const;

/** TAILLE TOTALE DE L'ESPACE — plus de 5 milliards d'échantillons uniques. */
export const TAILLE_ESPACE_ONDES_MULTIMODAL =
  ESPACE_ANALYSE_MULTIMODALE + ESPACE_VOIX_PAROLE + ESPACE_VIDEO_REALISTE + ESPACE_GENERATION_IMAGE;

/** Décode un index local en digits radices mixtes. */
function decoder(dims: readonly number[], local: number): number[] {
  const digits: number[] = [];
  let reste = local;
  for (let i = dims.length - 1; i >= 0; i--) {
    digits[i] = reste % dims[i];
    reste = Math.floor(reste / dims[i]);
  }
  return digits;
}

function uniteAnalyse(local: number): UniteOndesMultimodale {
  const d = decoder(DIMENSIONS_ANALYSE, local);
  const langue = LANGUES[d[4]];
  const texte = langue === "fr"
    ? `Analyse d'artefact : ${ARTEFACTS[d[0]]} ; défaut observé : ${DEFAUTS[d[1]]} ; contexte : ${CONTEXTES[d[2]]} ; livrable attendu : ${LIVRABLES[d[3]]}.`
    : `Artifact analysis: ${ARTEFACTS[d[0]]}; observed defect: ${DEFAUTS[d[1]]}; context: ${CONTEXTES[d[2]]}; expected deliverable: ${LIVRABLES[d[3]]}.`;
  return {
    domaine: "analyse_multimodale",
    langue,
    texte,
    instruction: langue === "fr" ? "Qualifie l'artefact et propose une démarche honnête." : "Assess the artifact and propose an honest path.",
    sortie: langue === "fr"
      ? `Démarche : décrire ce qui est observable, séparer l'inférable, poser les questions de clarification, livrer : ${LIVRABLES[d[3]]}. | Limite honnête : au-delà de la résolution et de la netteté réelles, déclarer l'illisible plutôt que deviner.`
      : `Path: describe what is observable, separate the inferable, ask clarifying questions, deliver: ${LIVRABLES[d[3]]}. | Honest limit: beyond the real resolution and sharpness, declare the unreadable rather than guess.`,
  };
}

function uniteVoix(local: number): UniteOndesMultimodale {
  const d = decoder(DIMENSIONS_VOIX, local);
  const langue = LANGUES[d[6]];
  const texte = langue === "fr"
    ? `Brief voix : usage ${USAGES_VOIX[d[0]]} ; registre ${REGISTRES[d[1]]} ; débit ${DEBITS[d[2]]} ; moteur ${MOTEURS_VOIX[d[3]]} ; segment ${SEGMENTS[d[4]]} ; durée ${LONGUEURS[d[5]]}.`
    : `Voice brief: usage ${USAGES_VOIX[d[0]]}; register ${REGISTRES[d[1]]}; pace ${DEBITS[d[2]]}; engine ${MOTEURS_VOIX[d[3]]}; segment ${SEGMENTS[d[4]]}; length ${LONGUEURS[d[5]]}.`;
  return {
    domaine: "voix_parole",
    langue,
    texte,
    instruction: langue === "fr" ? "Rédige le brief de voix avec paramètres moteur et limites." : "Write the voice brief with engine parameters and limits.",
    sortie: langue === "fr"
      ? `Réglages prêts : ${MOTEURS_VOIX[d[3]]}, ${LONGUEURS[d[5]]}, ${DEBITS[d[2]]}. | Limite honnête : F5-TTS est CC-BY-NC — passer par Kokoro (Apache-2.0) pour un usage commercial ; développer les chiffres dans le texte avant synthèse.`
      : `Settings ready: ${MOTEURS_VOIX[d[3]]}, ${LONGUEURS[d[5]]}, ${DEBITS[d[2]]}. | Honest limit: F5-TTS is CC-BY-NC — use Kokoro (Apache-2.0) for commercial use; spell out numbers before synthesis.`,
  };
}

function uniteVideo(local: number): UniteOndesMultimodale {
  const d = decoder(DIMENSIONS_VIDEO, local);
  const langue = LANGUES[d[6]];
  const texte = langue === "fr"
    ? `Storyboard LTX-Video : ${MOUVEMENTS[d[0]]} sur ${SCENES[d[1]]} ; lumière : ${LUMIERES_VIDEO[d[2]]} ; durée ${DUREES[d[3]]} ; ${RESOLUTIONS[d[4]]} ; ${VARIANTES[d[5]]}.`
    : `LTX-Video storyboard: ${MOUVEMENTS[d[0]]} over ${SCENES[d[1]]}; light: ${LUMIERES_VIDEO[d[2]]}; duration ${DUREES[d[3]]}; ${RESOLUTIONS[d[4]]}; ${VARIANTES[d[5]]}.`;
  return {
    domaine: "video_realiste",
    langue,
    texte,
    instruction: langue === "fr" ? "Rédige le storyboard d'un clip réaliste avec paramètres et limites." : "Write the storyboard of a realistic clip with parameters and limits.",
    sortie: langue === "fr"
      ? `Storyboard prêt : ${RESOLUTIONS[d[4]]}, ${DUREES[d[3]]}, ${VARIANTES[d[5]]}. | Limite honnête : plan unique de 2 à 6 secondes — la cohérence multi-scènes passe par un assemblage de clips validés un par un.`
      : `Storyboard ready: ${RESOLUTIONS[d[4]]}, ${DUREES[d[3]]}, ${VARIANTES[d[5]]}. | Honest limit: single shot of 2 to 6 seconds — multi-scene coherence comes from assembling validated clips one by one.`,
  };
}

function uniteImage(local: number): UniteOndesMultimodale {
  const d = decoder(DIMENSIONS_IMAGE, local);
  const langue = LANGUES[d[9]];
  const texte = langue === "fr"
    ? `Prompt photoréaliste : sujet ${SUJETS_IMAGE[d[0]]} ; lieu : ${LIEUX_IMAGE[d[1]]} ; ambiance : ${AMBIANCES[d[2]]} ; lumière : ${LUMIERES_IMAGE[d[3]]} ; optique : ${OPTIQUES[d[4]]} ; cadrage : ${CADRAGES[d[5]]} ; rendu : ${FILMS[d[6]]} ; ${FORMATS[d[7]]} ; ${VARIANTES[d[8]]}.`
    : `Photoreal prompt — subject: ${SUJETS_IMAGE[d[0]]}; place: ${LIEUX_IMAGE[d[1]]}; mood: ${AMBIANCES[d[2]]}; light: ${LUMIERES_IMAGE[d[3]]}; optics: ${OPTIQUES[d[4]]}; framing: ${CADRAGES[d[5]]}; rendering: ${FILMS[d[6]]}; ${FORMATS[d[7]]}; ${VARIANTES[d[8]]}.`;
  return {
    domaine: "generation_image",
    langue,
    texte,
    instruction: langue === "fr" ? "Construis le brief photoréaliste complet à 8 dimensions pour SDXL." : "Build the full 8-dimension photoreal brief for SDXL.",
    sortie: langue === "fr"
      ? `Prompt prêt pour SDXL + LoRA gen3 (${FORMATS[d[7]]}, ${VARIANTES[d[8]]}). | Limite honnête : le photoréalisme dépend du moteur entraîné ; vérifier visages, mains et textes générés avant livraison.`
      : `Prompt ready for SDXL + gen3 LoRA (${FORMATS[d[7]]}, ${VARIANTES[d[8]]}). | Honest limit: photorealism depends on the trained engine; check faces, hands and generated text before delivery.`,
  };
}

/**
 * Échantillon ADRESSABLE N — bijection N ↔ échantillon unique sur tout
 * l'espace [0, TAILLE_ESPACE_ONDES_MULTIMODAL). Hors bornes → erreur.
 */
export function uniteOndesMultimodale(index: number): UniteOndesMultimodale {
  if (!Number.isInteger(index) || index < 0 || index >= TAILLE_ESPACE_ONDES_MULTIMODAL) {
    throw new Error(`Index hors espace ondes multimodal : ${index} (borne ${TAILLE_ESPACE_ONDES_MULTIMODAL}).`);
  }
  if (index < OFFSETS_DOMAINES.voix_parole) return uniteAnalyse(index - OFFSETS_DOMAINES.analyse_multimodale);
  if (index < OFFSETS_DOMAINES.video_realiste) return uniteVoix(index - OFFSETS_DOMAINES.voix_parole);
  if (index < OFFSETS_DOMAINES.generation_image) return uniteVideo(index - OFFSETS_DOMAINES.video_realiste);
  return uniteImage(index - OFFSETS_DOMAINES.generation_image);
}

/** Lot contigu d'échantillons (matérialisation par shards). */
export function lotOndesMultimodale(debut: number, taille: number): UniteOndesMultimodale[] {
  const fin = debut + taille;
  if (taille < 0 || fin > TAILLE_ESPACE_ONDES_MULTIMODAL) {
    throw new Error(`Lot invalide : [${debut}, ${fin}) hors espace (borne ${TAILLE_ESPACE_ONDES_MULTIMODAL}).`);
  }
  const lot: UniteOndesMultimodale[] = [];
  for (let i = debut; i < fin; i++) lot.push(uniteOndesMultimodale(i));
  return lot;
}
