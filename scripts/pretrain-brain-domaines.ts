/**
 * PRÉ-ENTRAÎNEMENT DE LA COUCHE DES 18 DOMAINES — HORS PRODUCTION.
 *
 * À exécuter dans un environnement d'entraînement (sandbox / poste de dev)
 * où les datasets complets ont été générés :
 *   python3 training/gen3-domain-datasets/generateur.py            # 18×100k
 *   npx tsx scripts/pretrain-brain-domaines.ts                     # artefact
 *
 * Le script entraîne la couche domaine (pools 100-135 d'un réseau 140) avec
 * la MÊME plasticité que le trainer de production (miroir de
 * NeuralTrainer.trainDomaines : renforcement entrée → pool cible, punition
 * compétitive des pools concurrents, résonance pondérée par latence), puis
 * exporte les synapses de la couche dans
 * `assets/neural-pretrained/brain-domaines-v1.json` (commité).
 *
 * CADRAGE HONNÊTE (mesuré empiriquement, cf. doc de detecterDomaine) : la
 * zone d'entrée SNN (38 neurones de hachage) ne sépare pas 18 classes aux
 * vocabulaires recouvrants — l'accuracy SNN de cette couche reste proche du
 * hasard et est rapportée telle quelle. Le ROUTAGE de domaine en production
 * est LEXICAL (predireDomaineLexical, pattern labelText des actions) ; cette
 * couche SNN est le substrat vivant en plasticité — elle continue
 * d'apprendre (Studio, auto-apprentissage) et ses synapses amorcées ici
 * portent le vocabulaire réel des 18 datasets.
 *
 * Note d'architecture : ce script n'importe QUE des modules purs (le trainer
 * de production est "server-only" — importable uniquement dans le serveur
 * Next). La boucle ci-dessous est le miroir exact documenté de
 * lib/neural/training/trainer.ts (trainDomaines) — tout changement de
 * plasticité doit être répercuté des deux côtés.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ReseauNeuronalGen3 } from "../lib/neural/core/network";
import { Synapse } from "../lib/neural/core/synapse";
import { EspaceFiltreResonant } from "../lib/neural/core/resonant-space";
import { GenerateurAutoOscillation } from "../lib/neural/core/auto-oscillation";
import { NoyauCentralGen3 } from "../lib/neural/core/central-core";
import { createRng } from "../lib/neural/core/rng";
import { encodeText, tokenize } from "../lib/neural/encoding/text-encoder";
import { poidsResonanceParCycle } from "../lib/neural/decoding/response-decoder";
import {
  TAILLE_RESEAU_GEN3,
  ZONE_DOMAINES,
  SEUIL_POOL_DOMAINE,
} from "../lib/neural/core/types";

// ─── Les 18 domaines (miroir de training/domaines.ts) ───────────────────────

const DOMAINES: Array<{ id: string; pool: readonly number[]; motsCles: string[] }> = [
  { id: "generation_images", pool: [100, 101], motsCles: ["image", "visuel", "prompt", "style", "photo", "illustration"] },
  { id: "video", pool: [102, 103], motsCles: ["video", "clip", "film", "storyboard", "montage", "rendu"] },
  { id: "son", pool: [104, 105], motsCles: ["son", "audio", "voix", "ambiance", "sonore", "sound"] },
  { id: "clips_musicaux", pool: [106, 107], motsCles: ["musique", "refrain", "bpm", "genre", "music", "song"] },
  { id: "developpement_web", pool: [108, 109], motsCles: ["web", "html", "css", "javascript", "react", "api", "site"] },
  { id: "test", pool: [110, 111], motsCles: ["test", "tests", "qualite", "couverture", "qa", "pytest", "jest"] },
  { id: "redaction_documents", pool: [112, 113], motsCles: ["document", "rapport", "rediger", "courrier", "manuel", "writing"] },
  { id: "sciences_humaines", pool: [114, 115], motsCles: ["histoire", "sociologie", "philosophie", "culture", "societe", "anthropology"] },
  { id: "recherche_scientifique", pool: [116, 117], motsCles: ["science", "protocole", "hypothese", "experience", "research", "study"] },
  { id: "cybersecurite", pool: [118, 119], motsCles: ["securite", "cyber", "incident", "vulnerabilite", "patch", "cve", "mfa"] },
  { id: "hacker", pool: [124, 125], motsCles: ["ctf", "hacker", "flag", "challenge", "pentest", "exploit", "stego"] },
  { id: "recherche_web", pool: [120, 121], motsCles: ["recherche", "internet", "verifier", "fact-check", "browse", "online"] },
  { id: "multimodal", pool: [122, 123], motsCles: ["multimodal", "ocr", "alignement", "modalite", "cross-modal"] },
  { id: "construction_machines", pool: [126, 127], motsCles: ["machine", "robot", "moteur", "capteur", "arduino", "pid", "firmware"] },
  { id: "vente", pool: [128, 129], motsCles: ["vente", "objection", "pitch", "prospect", "sales", "deal"] },
  { id: "sante_medical", pool: [130, 131], motsCles: ["sante", "medical", "symptome", "traitement", "consultation", "wellness"] },
  { id: "analyse_donnees", pool: [132, 133], motsCles: ["donnees", "graphique", "statistique", "csv", "pandas", "chart"] },
  { id: "conseiller_commercial", pool: [134, 135], motsCles: ["conseil", "recommandation", "suivi", "advisor", "crm", "consulting"] },
];

const MOTS_CLES: Record<string, string[]> = Object.fromEntries(
  DOMAINES.map((d) => [d.id, d.motsCles]),
);

const DOMAINS_POOLS: Record<string, readonly number[]> = Object.fromEntries(
  DOMAINES.map((d) => [`DOM_${d.id.toUpperCase()}`, d.pool]),
);

// ─── Paramètres (alignés sur le trainer) ────────────────────────────────────

const SEED = 42;
const EPOCHS = 4;
const LR_BOOST = 0.15;
const CYCLES = 4;
const TEST_RATIO = 0.15;
/** Échantillons max par domaine (FR + EN confondus, instruction → label). */
const MAX_PAR_DOMAINE = 400;

const DIR_COMPLET = join(
  process.cwd(),
  "training/gen3-domain-datasets/data/complet",
);
const DIR_ECHANTILLONS = join(
  process.cwd(),
  "training/gen3-domain-datasets/data/echantillons",
);
const ARTEFACT = join(
  process.cwd(),
  "assets/neural-pretrained/brain-domaines-v1.json",
);

interface Echantillon {
  instruction: string;
  language: string;
}

/**
 * TEXTE D'ENTRAÎNEMENT — ANCRES du domaine présentes dans l'instruction
 * (miroir exact de texteEntrainement dans lib/neural/training/domaines.ts).
 * Cap 6 tokens : sans cap d'ancres, les ~2 700 tokens signatures rares
 * saturent le hachage 38 neurones (~70 tokens/neurone) et la classification
 * s'effondre au hasard — les ~24 ancres/domaine gardent le hachage
 * réparable par la punition compétitive.
 */
function texteEntrainement(
  instruction: string,
  signatures: ReadonlySet<string>,
  maxTokens = 6,
): string {
  const vus = new Set<string>();
  for (const token of tokenize(instruction)) {
    if (signatures.has(token) && !vus.has(token)) {
      vus.add(token);
      if (vus.size >= maxTokens) break;
    }
  }
  return [...vus].join(" ");
}

/** Ancres inter-domaines (miroir de construireSignaturesDomaines). */
function construireSignatures(
  corpus: Record<string, Echantillon[]>,
  motsClesParDomaine: Record<string, string[]>,
): Record<string, Set<string>> {
  const frequence: Record<string, number> = {};
  const tokensParDomaine: Record<string, Map<string, number>> = {};
  for (const [id, echantillons] of Object.entries(corpus)) {
    const tokens = new Map<string, number>();
    for (const echantillon of echantillons.slice(0, 4000)) {
      for (const token of tokenize(echantillon.instruction)) {
        if (token.length < 3) continue;
        tokens.set(token, (tokens.get(token) ?? 0) + 1);
      }
    }
    tokensParDomaine[id] = tokens;
  }
  for (const tokens of Object.values(tokensParDomaine)) {
    for (const token of tokens.keys()) frequence[token] = (frequence[token] ?? 0) + 1;
  }
  const signatures: Record<string, Set<string>> = {};
  for (const [id, tokens] of Object.entries(tokensParDomaine)) {
    const frequentes = [...tokens.entries()]
      .filter(([token, occurrences]) => frequence[token] <= 2 && occurrences >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([token]) => token)
      .slice(0, 24);
    signatures[id] = new Set(
      [...new Set([...(motsClesParDomaine[id] ?? []), ...frequentes])].slice(0, 24),
    );
  }
  return signatures;
}

function lireDomaine(id: string): Echantillon[] {
  const complet = join(DIR_COMPLET, `${id}.jsonl`);
  const chemin = existsSync(complet)
    ? complet
    : join(DIR_ECHANTILLONS, `${id}.jsonl`);
  if (!existsSync(chemin)) {
    throw new Error(`Dataset introuvable pour ${id} (${chemin}).`);
  }
  const brut = readFileSync(chemin, "utf8");
  const out: Echantillon[] = [];
  for (const ligne of brut.split("\n")) {
    if (!ligne.trim()) continue;
    try {
      const objet = JSON.parse(ligne) as Echantillon;
      if (typeof objet.instruction === "string" && objet.instruction.length >= 10) {
        out.push({ instruction: objet.instruction, language: String(objet.language ?? "fr") });
      }
    } catch {
      // Ligne corrompue ignorée.
    }
  }
  return out;
}

// ─── Assemblage (miroir du runtime, sans effecteurs média) ──────────────────

const reseau = new ReseauNeuronalGen3({ seed: SEED, size: TAILLE_RESEAU_GEN3 });
const espace = new EspaceFiltreResonant();
// ACCORD DE LA COUCHE DOMAINE (miroir de appliquerSeuilsDomaines) : une
// synapse renforcée à poids 1.0 transmet 0.9 après décroissance — au seuil
// global 1.0 un token unique ne déclencherait jamais son pool.
for (let id = ZONE_DOMAINES.debut; id <= ZONE_DOMAINES.fin; id++) {
  const neurone = reseau.neurones.get(id);
  if (neurone) neurone.threshold = SEUIL_POOL_DOMAINE;
}
const veille = new GenerateurAutoOscillation(
  reseau,
  0.15,
  0.15,
  createRng(SEED + 1),
);
const noyau = new NoyauCentralGen3(reseau, espace, veille);
for (const [label, pool] of Object.entries(DOMAINS_POOLS)) {
  espace.registerOutputPool(label, [...pool]);
}

// ─── Boucle (miroir de NeuralTrainer.propagerEchantillon + plasticité) ──────

function propager(
  texte: string,
): { encodage: ReturnType<typeof encodeText>; resonances: Record<string, number> } {
  for (const neurone of reseau.neurones.values()) neurone.energy = 0;
  const encodage = encodeText(texte);
  const fenetre = { id: `pretrain-${Math.random()}` };
  const contexte = { prompt: texte, __fenetreNeuronale: fenetre };
  const resonances: Record<string, number> = {};
  for (let c = 0; c < CYCLES; c++) {
    const requete =
      c === 0
        ? { intensite: 0, inputsDirects: encodage.inputs }
        : { intensite: 0 };
    const spiked = noyau.executerCycle(requete, contexte).spikedNeurones;
    const poids = poidsResonanceParCycle(c);
    for (const label of Object.keys(DOMAINS_POOLS)) {
      const score = espace.readResonance(spiked, label) * poids;
      if (score > (resonances[label] ?? 0)) resonances[label] = score;
    }
  }
  return { encodage, resonances };
}

function predire(resonances: Record<string, number>): string | null {
  let meilleur: string | null = null;
  let score = 0;
  for (const [label, valeur] of Object.entries(resonances)) {
    if (valeur > score) {
      meilleur = label;
      score = valeur;
    }
  }
  return meilleur;
}

const indexSynapses = new Map<string, Synapse>();
for (const s of reseau.synapses) indexSynapses.set(`${s.sourceId}->${s.targetId}`, s);

function renforcer(src: number, tgt: number): void {
  const cle = `${src}->${tgt}`;
  const existante = indexSynapses.get(cle);
  if (existante) {
    existante.weight = Math.min(1.0, existante.weight + LR_BOOST);
  } else if (src !== tgt) {
    const synapse = new Synapse(src, tgt, LR_BOOST);
    reseau.synapses.push(synapse);
    indexSynapses.set(cle, synapse);
  }
}

function affaiblirVersPool(pool: readonly number[]): void {
  const cibles = new Set(pool);
  const borne = 37 + 2; // ZONE_TOKENS.fin + POOL_UTILISATEUR_IN.length (39)
  for (const synapse of reseau.synapses) {
    if (synapse.sourceId <= borne && cibles.has(synapse.targetId)) {
      synapse.weight *= 0.95;
    }
  }
}

function apprendre(echantillon: { text: string; label: string }): string | null {
  const { encodage, resonances } = propager(echantillon.text);
  const prediction = predire(resonances);
  const poolCible = DOMAINS_POOLS[echantillon.label];
  if (poolCible) {
    for (const src of Object.keys(encodage.inputs).map(Number)) {
      for (const tgt of poolCible) renforcer(src, tgt);
    }
    const scoreCible = resonances[echantillon.label] ?? 0;
    for (const [label, pool] of Object.entries(DOMAINS_POOLS)) {
      if (label === echantillon.label) continue;
      if ((resonances[label] ?? 0) > scoreCible) affaiblirVersPool(pool);
    }
  }
  return prediction;
}

// ─── Chargement des échantillons ────────────────────────────────────────────

const corpus: Record<string, Echantillon[]> = {};
for (const domaine of DOMAINES) {
  corpus[domaine.id] = lireDomaine(domaine.id);
}
const signatures = construireSignatures(
  corpus,
  Object.fromEntries(DOMAINES.map((d) => [d.id, d.motsCles])),
);

const samples: Array<{ text: string; label: string }> = [];
const parDomaine: Record<string, number> = {};
for (const domaine of DOMAINES) {
  const label = `DOM_${domaine.id.toUpperCase()}`;
  const signaturesDomaine = signatures[domaine.id] ?? new Set<string>();
  let pris = 0;
  // AMORÇAGE LEXICAL : les mots-clés du domaine sont des échantillons à
  // part entière (garantie de vocabulaire noyau par pool).
  for (const motCle of MOTS_CLES[domaine.id] ?? []) {
    samples.push({ text: motCle, label });
    pris += 1;
  }
  for (const echantillon of corpus[domaine.id]) {
    if (pris >= MAX_PAR_DOMAINE) break;
    const texte = texteEntrainement(echantillon.instruction, signaturesDomaine);
    if (texte.length < 3) continue;
    samples.push({ text: texte, label });
    pris += 1;
  }
  parDomaine[domaine.id] = pris;
}
console.log(
  `Échantillons chargés : ${samples.length} (${Object.keys(parDomaine).length} domaines, cap ${MAX_PAR_DOMAINE}/domaine)`,
);

// ─── Shuffle seedé + découpe train/test (miroir du trainer) ─────────────────

const melange = [...samples];
const rng = createRng(2024);
for (let i = melange.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [melange[i], melange[j]] = [melange[j], melange[i]];
}
const nbTest = Math.max(1, Math.floor(melange.length * TEST_RATIO));
const train = melange.slice(0, melange.length - nbTest);
const test = melange.slice(melange.length - nbTest);

// ─── Entraînement ───────────────────────────────────────────────────────────

const debut = Date.now();
const history: Array<{ epoch: number; accuracy: number }> = [];
for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  let corrects = 0;
  for (const echantillon of train) {
    if (apprendre(echantillon) === echantillon.label) corrects += 1;
  }
  const accuracy = corrects / train.length;
  history.push({ epoch, accuracy });
  console.log(`  epoch ${epoch}/${EPOCHS} — accuracy train ${(accuracy * 100).toFixed(1)} %`);
}

// ─── Évaluation (sans plasticité) ───────────────────────────────────────────

let correctsTest = 0;
for (const echantillon of test) {
  const { resonances } = propager(echantillon.text);
  if (predire(resonances) === echantillon.label) correctsTest += 1;
}
const accuracyTest = correctsTest / test.length;

// ─── Export des synapses de la couche domaine ───────────────────────────────

const synapsesCouche = reseau.synapses
  .filter(
    (s) =>
      s.targetId >= ZONE_DOMAINES.debut ||
      s.sourceId >= ZONE_DOMAINES.debut,
  )
  .map((s) => [s.sourceId, s.targetId, Number(s.weight.toFixed(4))] as [number, number, number]);

const artefact = {
  version: 1,
  genereLe: new Date().toISOString(),
  source: "training/gen3-domain-datasets (18 × 100 000 lignes bilingues FR/EN, générateur seedé)",
  synapses: synapsesCouche,
  entrainement: {
    samples: train.length,
    epochs: EPOCHS,
    lrBoost: LR_BOOST,
    cyclesParEchantillon: CYCLES,
    accuracyTrain: history[history.length - 1]?.accuracy ?? 0,
    accuracyTest,
    parDomaine,
    history,
    dureeMs: Date.now() - debut,
  },
};

mkdirSync(dirname(ARTEFACT), { recursive: true });
writeFileSync(ARTEFACT, JSON.stringify(artefact), "utf8");
console.log(
  `\nArtefact écrit : ${ARTEFACT}\n  synapses couche domaine : ${synapsesCouche.length}\n  accuracy test : ${(accuracyTest * 100).toFixed(1)} %\n  durée : ${((Date.now() - debut) / 1000).toFixed(1)} s`,
);
