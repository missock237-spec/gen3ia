/**
 * it.71 — CAMPAGNE PLAFOND LEVÉ : BUDGET HOMÉOSTATIQUE 6.0 → 8.0
 * (SEULE VARIABLE CHANGÉE — expérience contrôlée sur substrat 2^23).
 *
 * Demandes propriétaires (permanentes) :
 *  - « un système qui va permettre à gen3 d'apprendre du générateur de
 *    dataset, pour qu'il puisse toujours continuer à s'améliorer en
 *    continu » (it.65) ;
 *  - « entraîne gen3 dans tous les domaines… continue jusqu'à ce qu'il
 *    atteigne le niveau requis » + « depuis tes propres serveurs locaux,
 *    1 million de données par domaine » ;
 *  - « fais en sorte qu'il soit capable de répondre à des questions qui
 *    rentrent dans son cadre d'apprentissage ».
 *
 * CANDIDAT №1 DÉCLARÉ it.70 §7 (mesuré ici, jamais estimé) :
 *  « Lever le plafond de saturation : élargir la dynamique des poids
 *   (cap 1.0 → budget homéostatique plus grand) sur substrat 2^23 et
 *   re-mesurer le C3b — la matière fraîche redeviendrait le levier
 *   au-delà de l'équilibre actuel. »
 *
 * RATIONNEL MÉCANIQUE : sous budget 6.0, l'homéostasie rescale les
 * colonnes entraînées vers le bas (47 980 normalisations mesurées
 * it.70) — le régime stationnaire plafonne la trace (C3b 6/19, ratios
 * 1,000 → 1,032 sur 2 358 856 arêtes saturées). Budget 8.0 (voisins ×
 * 0,667, sous le maximum 12) laisse les poids entraînés stationner plus
 * haut : moins de rescaling → discrimination plus forte → la matière
 * fraîche redevient un levier. RISQUE ACCEPTÉ ET MESURÉ : le facteur de
 * branchement effectif passe de ≤ 6 à ≤ 8 — la stabilité C4 (deltas par
 * bloc < 3), la durée par lot et le RSS (plafond 2 600 Mo) détectent une
 * avalanche ; abort honnête si elle apparaît.
 *
 * EXPÉRIENCE CONTRÔLÉE (comparabilité stricte) :
 *  - MÊME matière que it.69/70 (bijections offsets 30M puis 50M, 100 000
 *    /domaine × 19), MÊME graine 20261101, MÊME mécanique EOD it.57/63
 *    (cycles 3, lots ≤ 2000, lr 0.15), MÊMES horloges monotones (leçon
 *    it.70 verrouillée : sondes phase 1 à 90e9, vague 2 à 90,01e9, sondes
 *    phase 2 à 90,03e9) ;
 *  - SEULE VARIABLE : budgetPoidsSortants 6.0 → 8.0 ;
 *  - l'ANCRAGE budget 6.0 est l'artefact COMMIS it.70
 *    (boucle-continue-it70.json : C3a 14/19 bit-exact, C3b 6/19, survie
 *    13/19) — ce script n'est PAS un rejeu bit-exact (le budget change
 *    l'état), la comparaison est croisée entre deux artefacts committés ;
 *  - la carte des interférences est STRUCTURELLE (indépendante du budget :
 *    analyserOndeTexte/colonnesDepuisOndes ne lisent pas les poids) — elle
 *    n'est PAS re-mesurée ici, l'artefact it.70 fait foi.
 *
 * EXÉCUTION EN QUATRE PHASES (le contexte d'exécution borne chaque appel
 * à ~10 minutes — la campagne est REPRENABLE sans rien mesurer deux fois,
 * checkpoints binaires du cortex bit à bit, chaque échantillon entraîné
 * UNE fois — reprise GEN3IA_IT71_RESUME=1/2/3).
 *
 * Sortie : assets/neural-pretrained/plafond-leve-it71.json
 * (bilan C1..C4 + survie tel quel, limites honnêtes, zéro maquillage —
 * les échecs restent visibles, atteint calculé, jamais déclaré).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";
import { paireGenere } from "../lib/gen3/generateur-datasets";
import {
  entrainerDomainesParOndes,
  analyserOndeTexte,
  colonnesDepuisOndes,
  bandeDuDomaine,
  type ExempleOnde,
} from "../lib/neural/training/entrainement-ondes";
import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";

/* ------------------------------------------------------------------ */
/* Paramètres — identiques it.70 SAUF le budget (SEULE variable)        */
/* ------------------------------------------------------------------ */

const COLONNES = 8_388_608;
const FRAIS_PAR_DOMAINE = Number(process.env.GEN3IA_FRAIS_PAR_DOMAINE ?? 100_000);
const OFFSET_VAGUE1 = 30_000_000; // même bijection que it.69/70 vague 1
const OFFSET_VAGUE2 = 50_000_000; // même bijection que it.70 vague 2
const CYCLES = 3;
const TAILLE_LOT = 2000;
const LR = 0.15;
const LONGUEUR_TEXTE_MAX = 400;
/** Sondes S0/S1a (phase 1) — identiques it.70 (horloge lointaine). */
const HORLOGE_SONDE_1 = 90_000_000_000;
/** LEÇON it.70 (verrouillée) : horloges MONOTONES à travers vagues et
 *  sondes — la vague 2 part APRÈS les sondes de phase 1, les sondes de
 *  phase 2 après la vague 2. */
const HORLOGE_VAGUE2_DEPART = 90_010_000_000;
const HORLOGE_SONDE_2 = 90_030_000_000;
const GRAINE = 20261101;
const SEUIL_SATURE = 0.999;
/** ★ SEULE VARIABLE CHANGÉE vs it.69/70 : 12 × 0,5 = 6.0 → 12 × 0,667 = 8.0 */
const BUDGET = 8.0;
const PLAFOND_RSS_MO = Number(process.env.GEN3IA_PLAFOND_RSS_MO ?? 2600);
const environnement = process.env.GEN3IA_ENV ?? "serveur-local";
const cheminArtefact = join(
  process.cwd(),
  "assets/neural-pretrained/plafond-leve-it71.json",
);
/** Point de reprise (hors dépôt — l'artefact commis est le seul publié). */
const DIR_CHECKPOINT = "/home/z/my-project/workspace/it71-checkpoint";
const CHEMIN_PHASE_A = join(DIR_CHECKPOINT, "phase-a.json");

interface ExempleQA {
  texte: string;
  domaine: string;
  index: number;
}

function log(msg: string): void {
  console.log(`[it.71 ${new Date().toISOString()}] ${msg}`);
}

function memoireMo(): { rss: number; external: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  const r = (x: number) => Math.round((x / 1048576) * 10) / 10;
  return { rss: r(m.rss), external: r(m.external), arrayBuffers: r(m.arrayBuffers) };
}

function verifierMemoire(etape: string): void {
  const m = memoireMo();
  if (m.rss > PLAFOND_RSS_MO) {
    throw new Error(
      `GARDE-FOU MÉMOIRE : RSS ${m.rss} Mo > plafond ${PLAFOND_RSS_MO} Mo à l'étape « ${etape} » — abort honnête (aucun artefact partiel publié)`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Matière (mêmes bijections que it.69/70 — génération paresseuse)      */
/* ------------------------------------------------------------------ */

function texteQAFrais(domaine: string, index: number): string {
  const paire = paireGenere(domaine, index);
  const brut = `Q: ${paire.motif}\nR: ${paire.reponse}`;
  return brut.length <= LONGUEUR_TEXTE_MAX ? brut : `${brut.slice(0, LONGUEUR_TEXTE_MAX - 1)}…`;
}

/** Lot interclassé [debutLot, debutLot + taille) de la bijection
 *  round-robin (leçon it.63) — généré à la volée, zéro stockage global. */
function lotInterclasse(debutLot: number, taille: number, offset: number): ExempleQA[] {
  const sortie: ExempleQA[] = [];
  for (let r = debutLot; r < Math.min(debutLot + taille, FRAIS_PAR_DOMAINE * IDS_VOCATION.length); r++) {
    const domaine = IDS_VOCATION[r % IDS_VOCATION.length]!;
    const index = Math.floor(r / IDS_VOCATION.length);
    sortie.push({ texte: texteQAFrais(domaine, offset + index), domaine, index });
  }
  return sortie;
}

/* ------------------------------------------------------------------ */
/* Sondes de trace — formule EXACTE it.66/68/69/70 + détail PAR POINT   */
/* ------------------------------------------------------------------ */

interface SondePoint {
  domaine: string;
  texte: string;
  porteur: number;
  autres: number;
  ratio: number;
}

/** Chaque point est mesuré individuellement (le détail par point est
 *  publié dans l'artefact — une moyenne seule peut masquer un point qui
 *  s'effondre). L'ORDRE des passes est figé (charte). */
function sonderPoints(
  cortex: CortexColumnnaire,
  points: readonly { domaine: string; texte: string }[],
  horlogeSonde: number,
): SondePoint[] {
  const sortie: SondePoint[] = [];
  for (const pt of points) {
    const bande = bandeDuDomaine(pt.domaine);
    const paquets = analyserOndeTexte(pt.texte, horlogeSonde);
    const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
    cortex.pas(injections, horlogeSonde + 1);
    const activation = cortex.activationBandes();
    const porteur = activation[bande] ?? 0;
    let somme = 0;
    for (let b = 0; b < activation.length; b++) {
      if (b !== bande) somme += activation[b] ?? 0;
    }
    const autres = somme / Math.max(1, activation.length - 1);
    sortie.push({ domaine: pt.domaine, texte: pt.texte, porteur, autres, ratio: porteur / Math.max(1e-12, autres) });
  }
  return sortie;
}

function moyenneParDomaine(points: readonly SondePoint[]): Map<string, { porteur: number; autres: number; ratio: number }> {
  const acc = new Map<string, { p: number; a: number; n: number }>();
  for (const pt of points) {
    const a = acc.get(pt.domaine) ?? { p: 0, a: 0, n: 0 };
    a.p += pt.porteur;
    a.a += pt.autres;
    a.n += 1;
    acc.set(pt.domaine, a);
  }
  const sortie = new Map<string, { porteur: number; autres: number; ratio: number }>();
  for (const [domaine, a] of acc) {
    const porteur = a.p / a.n;
    const autres = a.a / a.n;
    sortie.set(domaine, { porteur, autres, ratio: porteur / Math.max(1e-12, autres) });
  }
  return sortie;
}

/** Points de sonde — les textes bijection ENTRAÎNÉS (début et fin de la
 *  vague), formule it.66/68/69/70. */
function pointsDeSonde(offset: number): { domaine: string; texte: string }[] {
  const points: { domaine: string; texte: string }[] = [];
  for (const domaine of IDS_VOCATION) {
    points.push({ domaine, texte: texteQAFrais(domaine, offset) });
    points.push({ domaine, texte: texteQAFrais(domaine, offset + FRAIS_PAR_DOMAINE - 1) });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* Stabilité (deltas par bloc — leçon it.68/69/70)                      */
/* ------------------------------------------------------------------ */

interface MesureBloc {
  vague: 1 | 2;
  bloc: number;
  echantillons: number;
  transmissions: number;
  transmissionsCumul: number;
  aretesSaturees: number;
  poidsMax: number;
  attenteEchantillon: number;
  normalisations: number;
  normalisationsCumul: number;
  rssMo: number;
}

function mesurerStabilite(
  cortex: CortexColumnnaire,
  vague: 1 | 2,
  bloc: number,
  echantillons: number,
  transmissionsBloc: number,
  transmissionsCumul: number,
  normalisationsBloc: number,
  normalisationsCumul: number,
): MesureBloc {
  let saturees = 0;
  let poidsMax = 0;
  for (let p = 0; p < cortex.csrPoids.length; p++) {
    const w = cortex.csrPoids[p]!;
    if (w >= SEUIL_SATURE) saturees += 1;
    if (w > poidsMax) poidsMax = w;
  }
  return {
    vague,
    bloc,
    echantillons,
    transmissions: transmissionsBloc,
    transmissionsCumul,
    aretesSaturees: saturees,
    poidsMax: Math.round(poidsMax * 1e6) / 1e6,
    attenteEchantillon: cortex.tailleListeAttente,
    normalisations: normalisationsBloc,
    normalisationsCumul,
    rssMo: memoireMo().rss,
  };
}

/* ------------------------------------------------------------------ */
/* Boucle d'entraînement d'une vague (EOD it.57/63 inchangée)           */
/* ------------------------------------------------------------------ */

type Metabolisme = { evaluees: number; reposes: number; transmissions: number; ms: number; normalisations: number };

interface BilanVague {
  echantillonsTraites: number;
  dureeMs: number;
  horlogeFinale: number;
  metabolisme: Metabolisme;
  bilanDomaines: Map<string, { echantillons: number; renforts: number; annulations: number; resonance: number; mesures: number }>;
}

function entrainerVague(
  cortex: CortexColumnnaire,
  champ: ChampCorticalGen3,
  offset: number,
  vague: 1 | 2,
  horlogeDepart: number,
  mesures: MesureBloc[],
  metabolismeGlobal: Metabolisme,
): BilanVague {
  const totalFrais = FRAIS_PAR_DOMAINE * IDS_VOCATION.length;
  const bilanDomaines = new Map<string, { echantillons: number; renforts: number; annulations: number; resonance: number; mesures: number }>();
  const metabolisme: Metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0, normalisations: 0 };
  let horloge = horlogeDepart;
  let echantillonsTraites = 0;
  const BLOC_MESURE = 190_000;
  const LOG_LOT = 50;
  const debut = Date.now();

  for (let debutLot = 0; debutLot < totalFrais; debutLot += TAILLE_LOT) {
    const lot = lotInterclasse(debutLot, TAILLE_LOT, offset);
    const rapports = entrainerDomainesParOndes(
      cortex,
      champ,
      lot as unknown as ExempleOnde[],
      {
        cyclesParEchantillon: CYCLES,
        lrBoost: LR,
        maxParDomaine: TAILLE_LOT,
        horlogeInitiale: horloge,
      },
    );
    horloge += CYCLES * lot.length;
    echantillonsTraites += rapports.totalEchantillons;
    metabolisme.evaluees += rapports.metabolisme.evaluees;
    metabolisme.reposes += rapports.metabolisme.reposes;
    metabolisme.transmissions += rapports.metabolisme.transmissions;
    metabolisme.ms = Math.round((metabolisme.ms + rapports.metabolisme.ms) * 1000) / 1000;
    metabolisme.normalisations += rapports.metabolisme.normalisations;
    for (const d of rapports.domaines) {
      const acc = bilanDomaines.get(d.domaine) ?? { echantillons: 0, renforts: 0, annulations: 0, resonance: 0, mesures: 0 };
      acc.echantillons += d.echantillons;
      acc.renforts += d.renforts;
      acc.annulations += d.annulations;
      acc.resonance += d.resonanceMoyenne;
      acc.mesures += 1;
      bilanDomaines.set(d.domaine, acc);
    }
    if ((debutLot / TAILLE_LOT) % LOG_LOT === 0) {
      log(`Vague ${vague} — ${echantillonsTraites.toLocaleString("fr-FR")}/${totalFrais.toLocaleString("fr-FR")} éch. · horloge ${horloge.toLocaleString("fr-FR")} · trans ${(metabolismeGlobal.transmissions + metabolisme.transmissions).toLocaleString("fr-FR")} · RSS ${memoireMo().rss} Mo`);
    }
    if (echantillonsTraites % BLOC_MESURE < TAILLE_LOT) {
      const transmissionsBloc = metabolismeGlobal.transmissions + metabolisme.transmissions - (mesures.length > 0 ? mesures[mesures.length - 1]!.transmissionsCumul : 0);
      const normalisationsBloc = metabolismeGlobal.normalisations + metabolisme.normalisations - (mesures.length > 0 ? mesures[mesures.length - 1]!.normalisationsCumul : 0);
      mesures.push(
        mesurerStabilite(cortex, vague, mesures.length + 1, echantillonsTraites, transmissionsBloc, metabolismeGlobal.transmissions + metabolisme.transmissions, normalisationsBloc, metabolismeGlobal.normalisations + metabolisme.normalisations),
      );
      const m = mesures[mesures.length - 1]!;
      log(`Bloc ${m.bloc} (vague ${vague}) — ${m.echantillons.toLocaleString("fr-FR")} éch. · saturées ${m.aretesSaturees.toLocaleString("fr-FR")} · poidsMax ${m.poidsMax} · norm ${m.normalisations.toLocaleString("fr-FR")} · RSS ${m.rssMo} Mo`);
      verifierMemoire(`bloc ${m.bloc} vague ${vague}`);
    }
  }
  return { echantillonsTraites, dureeMs: Date.now() - debut, horlogeFinale: horloge, metabolisme, bilanDomaines };
}

/* ------------------------------------------------------------------ */
/* CHECKPOINT — l'état mutable complet du cortex, bit à bit              */
/* ------------------------------------------------------------------ */

function ecrireBinaire(chemin: string, tableau: Float32Array | Float64Array | Uint8Array | Uint32Array): void {
  const tampon = Buffer.from(tableau.buffer, tableau.byteOffset, tableau.byteLength);
  writeFileSync(chemin, tampon);
}

function lireBinaire(chemin: string): ArrayBuffer {
  const tampon = readFileSync(chemin);
  return tampon.buffer.slice(tampon.byteOffset, tampon.byteOffset + tampon.byteLength);
}

/** L'état mutable complet du cortex, bit à bit — enAttente est écrit en
 *  BINAIRE u32 (un JSON.stringify d'un tableau de millions d'entrées peut
 *  dépasser la limite de chaîne V8 et coûte des dizaines de secondes :
 *  leçon it.71 de segmentation). `metaExtra` porte le JSON de phase. */
function sauverEtatBinaire(
  prefixe: string,
  cortex: CortexColumnnaire,
  metaExtra: Record<string, unknown>,
): void {
  const tCkpt = Date.now();
  mkdirSync(DIR_CHECKPOINT, { recursive: true });
  const interne = cortex as unknown as Record<string, unknown>;
  const enAttente = interne.enAttente as number[];
  log(`CHECKPOINT ${prefixe || "A"} : écriture (enAttente ${enAttente.length.toLocaleString("fr-FR")} entrées)…`);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}csrPoids.f32`), cortex.csrPoids);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}energies.f32`), cortex.energies);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}dernierSpike.f64`), cortex.dernierSpike);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}dernierTouche.f64`), cortex.dernierTouche);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}flagSpike.u8`), interne.flagSpike as Uint8Array);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}enFile.u8`), interne.enFile as Uint8Array);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}dernierResonance.f32`), interne.dernierResonance as Float32Array);
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}energieBandes.f32`), interne.energieBandes as Float32Array);
  const enAttenteU32 = new Uint32Array(enAttente.length);
  for (let i = 0; i < enAttente.length; i++) enAttenteU32[i] = enAttente[i]!;
  ecrireBinaire(join(DIR_CHECKPOINT, `${prefixe}enAttente.u32`), enAttenteU32);
  const meta = {
    ...metaExtra,
    msCycle: interne.msCycle as number,
    metabolismeDernierPas: cortex.metabolismeDernierPas,
  };
  writeFileSync(join(DIR_CHECKPOINT, `${prefixe}meta.json`), JSON.stringify(meta));
  log(`CHECKPOINT ${prefixe || "A"} écrit en ${((Date.now() - tCkpt) / 1000).toFixed(1)} s — reprise possible`);
}

/** Restaure le cortex depuis un checkpoint binaire (structure reconstruite
 *  depuis la graine — déterministe — puis poids et états restaurés bit à
 *  bit ; enAttente relue depuis le u32). Retourne aussi le meta JSON. */
function restaurerEtatBinaire(prefixe: string): { cortex: CortexColumnnaire; meta: Record<string, unknown> } {
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES,
    seed: GRAINE,
    normalisationHomeostatique: true,
    budgetPoidsSortants: BUDGET,
  });
  const interne = cortex as unknown as Record<string, unknown>;
  interne.flagSpike = new Uint8Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}flagSpike.u8`)));
  interne.enFile = new Uint8Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}enFile.u8`)));
  interne.dernierResonance = new Float32Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}dernierResonance.f32`)));
  interne.energieBandes = new Float32Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}energieBandes.f32`)));
  cortex.csrPoids.set(new Float32Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}csrPoids.f32`))));
  cortex.energies.set(new Float32Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}energies.f32`))));
  cortex.dernierSpike.set(new Float64Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}dernierSpike.f64`))));
  cortex.dernierTouche.set(new Float64Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}dernierTouche.f64`))));
  const u32 = new Uint32Array(lireBinaire(join(DIR_CHECKPOINT, `${prefixe}enAttente.u32`)));
  interne.enAttente = Array.from(u32);
  const meta = JSON.parse(readFileSync(join(DIR_CHECKPOINT, `${prefixe}meta.json`), "utf8")) as Record<string, unknown>;
  interne.msCycle = meta.msCycle as number;
  Object.assign(cortex.metabolismeDernierPas, meta.metabolismeDernierPas);
  return { cortex, meta };
}

interface EtatPhaseA {
  memoire: { avantAllocation: { rss: number; external: number; arrayBuffers: number }; apresAllocation: { rss: number; external: number; arrayBuffers: number } };
  sondesScratchV1: Array<{ domaine: string; porteur: number; autres: number; ratio: number }>;
  sondesApresV1SurV1: Array<{ domaine: string; porteur: number; autres: number; ratio: number }>;
  sondesApresV1SurV2: Array<{ domaine: string; porteur: number; autres: number; ratio: number }>;
  vague1: {
    echantillonsTraites: number;
    dureeMs: number;
    horlogeFinale: number;
    metabolisme: Metabolisme;
    bilanDomaines: Array<[string, { echantillons: number; renforts: number; annulations: number; resonance: number; mesures: number }]>;
  };
  mesures: MesureBloc[];
  metabolismeGlobal: Metabolisme;
}

/* ------------------------------------------------------------------ */
/* PHASE 1a — substrat neuf + sondes NEUF + vague 1 + CHECKPOINT "1-"   */
/* ------------------------------------------------------------------ */

function phase1a(): void {
  log(`Campagne PLAFOND LEVÉ — substrat ${COLONNES.toLocaleString("fr-FR")} colonnes (2^23), budget homéostatique 8.0 (SEULE variable vs it.69/70 : 6.0), vague 1 offset ${OFFSET_VAGUE1.toLocaleString("fr-FR")}, vague 2 offset ${OFFSET_VAGUE2.toLocaleString("fr-FR")}, ${FRAIS_PAR_DOMAINE.toLocaleString("fr-FR")}/domaine/vague, graine ${GRAINE}, environnement ${environnement}`);

  const avantAllocation = memoireMo();
  log(`Mémoire avant allocation : RSS ${avantAllocation.rss} Mo`);

  const t0 = Date.now();
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES,
    seed: GRAINE,
    normalisationHomeostatique: true,
    budgetPoidsSortants: BUDGET,
  });
  const apresAllocation = memoireMo();
  log(`Substrat construit en ${((Date.now() - t0) / 1000).toFixed(1)} s — RSS ${apresAllocation.rss} Mo (arêtes ${cortex.csrCible.length.toLocaleString("fr-FR")})`);
  verifierMemoire("construction substrat");

  const champ = new ChampCorticalGen3(GRAINE);
  const pointsV1 = pointsDeSonde(OFFSET_VAGUE1);

  // ---------- S0 : sondes NEUF, vague 1 ----------
  const scratchV1 = sonderPoints(cortex, pointsV1, HORLOGE_SONDE_1);
  log(`Sondes NEUF vague 1 mesurées (${scratchV1.length} points, horloge lointaine ${HORLOGE_SONDE_1.toLocaleString("fr-FR")})`);

  // ---------- VAGUE 1 (matière identique it.69/70, budget 8.0) ----------
  const mesures: MesureBloc[] = [];
  const metabolismeGlobal: Metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0, normalisations: 0 };
  const vague1 = entrainerVague(cortex, champ, OFFSET_VAGUE1, 1, 0, mesures, metabolismeGlobal);
  log(`Vague 1 terminée : ${vague1.echantillonsTraites.toLocaleString("fr-FR")} éch., horloge ${vague1.horlogeFinale.toLocaleString("fr-FR")}, ${vague1.dureeMs.toLocaleString("fr-FR")} ms`);
  verifierMemoire("fin vague 1");

  // ---------- CHECKPOINT "1-" (l'état APRÈS vague 1) ----------
  sauverEtatBinaire("1-", cortex, {
    memoire: { avantAllocation, apresAllocation },
    sondesScratchV1: scratchV1.map((p) => ({ domaine: p.domaine, porteur: p.porteur, autres: p.autres, ratio: p.ratio })),
    vague1: {
      echantillonsTraites: vague1.echantillonsTraites,
      dureeMs: vague1.dureeMs,
      horlogeFinale: vague1.horlogeFinale,
      metabolisme: vague1.metabolisme,
      bilanDomaines: [...vague1.bilanDomaines.entries()],
    },
    mesures,
    metabolismeGlobal,
  });
}

/* ------------------------------------------------------------------ */
/* PHASE 1b — S1a (C3) + S1b (baseline vague 2) depuis le checkpoint 1- */
/* ------------------------------------------------------------------ */

function phase1b(): { cortex: CortexColumnnaire; etat: EtatPhaseA } {
  log("REPRISE niveau 1 — checkpoint après vague 1 (S1a + S1b)…");
  const { cortex, meta } = restaurerEtatBinaire("1-");
  const pointsV1 = pointsDeSonde(OFFSET_VAGUE1);
  const pointsV2 = pointsDeSonde(OFFSET_VAGUE2);
  const scratchV1 = (meta.sondesScratchV1 as EtatPhaseA["sondesScratchV1"]).map((p) => ({ domaine: p.domaine, texte: "", porteur: p.porteur, autres: p.autres, ratio: p.ratio }));

  // ---------- S1a : sondes APRÈS vague 1, points vague 1 ----------
  const apresV1_surV1 = sonderPoints(cortex, pointsV1, HORLOGE_SONDE_1);
  const moyApresV1V1 = moyenneParDomaine(apresV1_surV1);
  const moyScratchV1 = moyenneParDomaine(scratchV1);
  const c3b8 = IDS_VOCATION.filter((id) => {
    const av = moyScratchV1.get(id)?.ratio ?? 0;
    const ap = moyApresV1V1.get(id)?.ratio ?? 0;
    return ap / Math.max(1e-12, av) > 1;
  }).length;
  log(`C3 (budget 8.0, sémantique scratch) : ${c3b8}/19 — ancrage budget 6.0 : 14/19 (artefact it.70, même matière offset 30M)`);
  verifierMemoire("sondes après vague 1");

  // ---------- S1b : sondes APRÈS vague 1, points vague 2 (baseline vague 2) ----------
  const apresV1_surV2 = sonderPoints(cortex, pointsV2, HORLOGE_SONDE_1);
  log(`Baseline vague 2 mesurée (${apresV1_surV2.length} points sur l'état après vague 1)`);

  const etatPhaseA: EtatPhaseA = {
    memoire: meta.memoire as EtatPhaseA["memoire"],
    sondesScratchV1: meta.sondesScratchV1 as EtatPhaseA["sondesScratchV1"],
    sondesApresV1SurV1: apresV1_surV1.map((p) => ({ domaine: p.domaine, porteur: p.porteur, autres: p.autres, ratio: p.ratio })),
    sondesApresV1SurV2: apresV1_surV2.map((p) => ({ domaine: p.domaine, porteur: p.porteur, autres: p.autres, ratio: p.ratio })),
    vague1: meta.vague1 as EtatPhaseA["vague1"],
    mesures: meta.mesures as MesureBloc[],
    metabolismeGlobal: meta.metabolismeGlobal as Metabolisme,
  };
  writeFileSync(CHEMIN_PHASE_A, JSON.stringify(etatPhaseA));
  log("Phase A complète (phase-a.json) — C3 mesuré, baseline vague 2 prête.");
  return { cortex, etat: etatPhaseA };
}

/* ------------------------------------------------------------------ */
/* PHASE 2 — vague 2 (la boucle continue, horloge MONOTONE 90,01e9)     */
/* ------------------------------------------------------------------ */

interface EtatCkpt2 {
  vague2: {
    echantillonsTraites: number;
    dureeMs: number;
    horlogeFinale: number;
    metabolisme: Metabolisme;
    bilanDomaines: Array<[string, { echantillons: number; renforts: number; annulations: number; resonance: number; mesures: number }]>;
  };
  mesures: MesureBloc[];
  metabolismeGlobal: Metabolisme;
}

function phase2(cortex: CortexColumnnaire, etat1: EtatPhaseA): EtatCkpt2 {
  const mesures = etat1.mesures;
  const metabolismeGlobal = etat1.metabolismeGlobal;

  // Champ par vague (pas de rétroaction champ→cortex — documenté).
  const champ2 = new ChampCorticalGen3(GRAINE);

  const vague2 = entrainerVague(cortex, champ2, OFFSET_VAGUE2, 2, HORLOGE_VAGUE2_DEPART, mesures, metabolismeGlobal);
  log(`Vague 2 terminée : ${vague2.echantillonsTraites.toLocaleString("fr-FR")} éch., horloge ${vague2.horlogeFinale.toLocaleString("fr-FR")}, ${vague2.dureeMs.toLocaleString("fr-FR")} ms`);
  verifierMemoire("fin vague 2");

  // Fusion métabolique : le global porte le CUMUL réel des deux vagues
  // (les deltas de bloc de la vague 2 sont ainsi positifs et le total de
  // l'artefact est la somme vraie — leçon de comptabilité it.70).
  metabolismeGlobal.evaluees += vague2.metabolisme.evaluees;
  metabolismeGlobal.reposes += vague2.metabolisme.reposes;
  metabolismeGlobal.transmissions += vague2.metabolisme.transmissions;
  metabolismeGlobal.ms = Math.round((metabolismeGlobal.ms + vague2.metabolisme.ms) * 1000) / 1000;
  metabolismeGlobal.normalisations += vague2.metabolisme.normalisations;

  const etat2: EtatCkpt2 = {
    vague2: {
      echantillonsTraites: vague2.echantillonsTraites,
      dureeMs: vague2.dureeMs,
      horlogeFinale: vague2.horlogeFinale,
      metabolisme: vague2.metabolisme,
      bilanDomaines: [...vague2.bilanDomaines.entries()],
    },
    mesures,
    metabolismeGlobal,
  };
  sauverEtatBinaire("2-", cortex, {
    vague2: etat2.vague2,
    mesures,
    metabolismeGlobal,
  });
  return etat2;
}

/* ------------------------------------------------------------------ */
/* PHASE 3 — sondes S2a (survie mémoire, horloge MONOTONE 90,03e9)      */
/* ------------------------------------------------------------------ */

interface EtatCkpt3 {
  sondesApresV2SurV1: Array<{ domaine: string; porteur: number; autres: number; ratio: number }>;
  mesures: MesureBloc[];
  metabolismeGlobal: Metabolisme;
}

function phase3(cortex: CortexColumnnaire, etat2: EtatCkpt2): EtatCkpt3 {
  const pointsV1 = pointsDeSonde(OFFSET_VAGUE1);
  const apresV2_surV1 = sonderPoints(cortex, pointsV1, HORLOGE_SONDE_2);
  log(`Sondes S2a mesurées (${apresV2_surV1.length} points — survie mémoire vague 1, horloge lointaine ${HORLOGE_SONDE_2.toLocaleString("fr-FR")})`);

  const etat3: EtatCkpt3 = {
    sondesApresV2SurV1: apresV2_surV1.map((p) => ({ domaine: p.domaine, porteur: p.porteur, autres: p.autres, ratio: p.ratio })),
    mesures: etat2.mesures,
    metabolismeGlobal: etat2.metabolismeGlobal,
  };
  sauverEtatBinaire("3-", cortex, {
    sondesApresV2SurV1: etat3.sondesApresV2SurV1,
    mesures: etat3.mesures,
    metabolismeGlobal: etat3.metabolismeGlobal,
  });
  return etat3;
}

/* ------------------------------------------------------------------ */
/* PHASE 4 — sondes S2b (C3b budget 8.0), bilan, ARTEFACT               */
/* ------------------------------------------------------------------ */

function phase4(
  cortex: CortexColumnnaire,
  etat1: EtatPhaseA,
  etat2: EtatCkpt2,
  etat3: EtatCkpt3,
): void {
  const pointsV2 = pointsDeSonde(OFFSET_VAGUE2);
  const apresV2_surV2 = sonderPoints(cortex, pointsV2, HORLOGE_SONDE_2);
  const moyApresV2V2 = moyenneParDomaine(apresV2_surV2);
  const apresV2_surV1 = etat3.sondesApresV2SurV1.map((p) => ({ domaine: p.domaine, texte: "", porteur: p.porteur, autres: p.autres, ratio: p.ratio }));
  const moyApresV2V1 = moyenneParDomaine(apresV2_surV1);

  const moyScratchV1 = moyenneParDomaine(etat1.sondesScratchV1.map((p) => ({ domaine: p.domaine, texte: "", porteur: p.porteur, autres: p.autres, ratio: p.ratio })));
  const moyApresV1V1 = moyenneParDomaine(etat1.sondesApresV1SurV1.map((p) => ({ domaine: p.domaine, texte: "", porteur: p.porteur, autres: p.autres, ratio: p.ratio })));
  const moyAvantV2 = moyenneParDomaine(etat1.sondesApresV1SurV2.map((p) => ({ domaine: p.domaine, texte: "", porteur: p.porteur, autres: p.autres, ratio: p.ratio })));

  const c3 = IDS_VOCATION.filter((id) => {
    const av = moyScratchV1.get(id)?.ratio ?? 0;
    const ap = moyApresV1V1.get(id)?.ratio ?? 0;
    return ap / Math.max(1e-12, av) > 1;
  }).length;
  const c3b = IDS_VOCATION.filter((id) => {
    const av = moyAvantV2.get(id)?.ratio ?? 0;
    const ap = moyApresV2V2.get(id)?.ratio ?? 0;
    return ap / Math.max(1e-12, av) > 1;
  }).length;
  const survieCount = IDS_VOCATION.filter((id) => {
    const ap1 = moyApresV1V1.get(id)?.ratio ?? 0;
    const ap2 = moyApresV2V1.get(id)?.ratio ?? 0;
    return ap2 / Math.max(1e-12, ap1) > 1;
  }).length;
  log(`C3 (budget 8.0) : ${c3}/19 · C3b (boucle continue, budget 8.0) : ${c3b}/19 · survie mémoire vague 1 : ${survieCount}/19`);

  /* ---------------- BILAN PAR DOMAINE (comptage RÉEL) ---------------- */
  const vague1Bilan = new Map(etat1.vague1.bilanDomaines);
  const vague2Bilan = new Map(etat2.vague2.bilanDomaines);
  const mesures = etat3.mesures;
  const parDomaine = IDS_VOCATION.map((id) => {
    const dom = DOMAINES_VOCATION.find((d) => d.id === id)!;
    const b1 = vague1Bilan.get(id) ?? { echantillons: 0, renforts: 0, annulations: 0, resonance: 0, mesures: 0 };
    const b2 = vague2Bilan.get(id) ?? { echantillons: 0, renforts: 0, annulations: 0, resonance: 0, mesures: 0 };
    const s0 = moyScratchV1.get(id) ?? { ratio: 0 };
    const a1v1 = moyApresV1V1.get(id) ?? { ratio: 0 };
    const a1v2 = moyAvantV2.get(id) ?? { ratio: 0 };
    const a2v1 = moyApresV2V1.get(id) ?? { ratio: 0 };
    const a2v2 = moyApresV2V2.get(id) ?? { ratio: 0 };
    const c3Dom = a1v1.ratio / Math.max(1e-12, s0.ratio);
    const c3bDom = a2v2.ratio / Math.max(1e-12, a1v2.ratio);
    const survieDom = a2v1.ratio / Math.max(1e-12, a1v1.ratio);
    return {
      id,
      label: dom.label,
      bandeVocab: bandeDuDomaine(id),
      echantillonsVague1: b1.echantillons,
      renfortsVague1: b1.renforts,
      echantillonsVague2: b2.echantillons,
      renfortsVague2: b2.renforts,
      traceScratchV1: Math.round(s0.ratio * 1e6) / 1e6,
      traceApresVague1: Math.round(a1v1.ratio * 1e6) / 1e6,
      c3: Math.round(c3Dom * 1e6) / 1e6,
      c3Atteint: c3Dom > 1,
      traceAvantVague2: Math.round(a1v2.ratio * 1e6) / 1e6,
      traceApresVague2: Math.round(a2v2.ratio * 1e6) / 1e6,
      c3b: Math.round(c3bDom * 1e6) / 1e6,
      c3bAtteint: c3bDom > 1,
      traceApresVague2SurVague1: Math.round(a2v1.ratio * 1e6) / 1e6,
      survie: Math.round(survieDom * 1e6) / 1e6,
      survieAtteint: survieDom > 1,
    };
  });
  const c1v1 = parDomaine.filter((d) => d.echantillonsVague1 >= FRAIS_PAR_DOMAINE).length;
  const c1v2 = parDomaine.filter((d) => d.echantillonsVague2 >= FRAIS_PAR_DOMAINE).length;
  const c2v1 = parDomaine.filter((d) => d.renfortsVague1 > 0).length;
  const c2v2 = parDomaine.filter((d) => d.renfortsVague2 > 0).length;

  // Détail PAR POINT de sonde (une moyenne seule peut masquer un point qui
  // s'effondre) — vague 1 : scratch / après vague 1 / après vague 2 ;
  // vague 2 : avant (après vague 1) / après vague 2.
  const detailPointsV1 = etat1.sondesScratchV1.map((p, i) => ({
    domaine: p.domaine,
    indice: i % 2 === 0 ? "debut" : "fin",
    ratioScratch: Math.round(p.ratio * 1e6) / 1e6,
    ratioApresVague1: Math.round(etat1.sondesApresV1SurV1[i]!.ratio * 1e6) / 1e6,
    ratioApresVague2: Math.round(etat3.sondesApresV2SurV1[i]!.ratio * 1e6) / 1e6,
  }));
  const detailPointsV2 = etat1.sondesApresV1SurV2.map((p, i) => ({
    domaine: p.domaine,
    indice: i % 2 === 0 ? "debut" : "fin",
    ratioAvantVague2: Math.round(p.ratio * 1e6) / 1e6,
    ratioApresVague2: Math.round(apresV2_surV2[i]!.ratio * 1e6) / 1e6,
  }));

  // C4 stabilité : ratio des DELTAS par bloc (leçon it.68/69/70), par vague.
  const blocsV1 = mesures.filter((m) => m.vague === 1);
  const blocsV2 = mesures.filter((m) => m.vague === 2);
  const ratioV1 =
    blocsV1.length >= 2 && blocsV1[0]!.transmissions > 0
      ? blocsV1[blocsV1.length - 1]!.transmissions / blocsV1[0]!.transmissions
      : 1;
  const ratioV2 =
    blocsV2.length >= 2 && blocsV2[0]!.transmissions > 0
      ? blocsV2[blocsV2.length - 1]!.transmissions / blocsV2[0]!.transmissions
      : 1;

  const picRssMo = Math.max(...mesures.map((m) => m.rssMo), memoireMo().rss);

  const artefact = {
    session: "campagne-plafond-leve-it71",
    date: new Date().toISOString(),
    environnement,
    demandeProprietaire:
      "un système qui apprend du générateur pour s'améliorer en continu (it.65) — depuis tes propres serveurs locaux, 1 million de données par domaine, questions dans le cadre (instruction raffinée)",
    parametres: {
      colonnes: COLONNES,
      budgetPoidsSortants: BUDGET,
      budgetAncreIt70: 6.0,
      seuleVariable: "budgetPoidsSortants : 6.0 (it.69/70) → 8.0 (ce tick) — expérience contrôlée, tout le reste identique",
      vagues: [
        { vague: 1, offsetBijection: OFFSET_VAGUE1, fraisParDomaine: FRAIS_PAR_DOMAINE, horloges: `0 → ${etat1.vague1.horlogeFinale.toLocaleString("fr-FR")}`, note: "même bijection que it.69/70 vague 1 (30M) — comparaison croisée budget 8.0 vs 6.0" },
        { vague: 2, offsetBijection: OFFSET_VAGUE2, fraisParDomaine: FRAIS_PAR_DOMAINE, horloges: `${HORLOGE_VAGUE2_DEPART.toLocaleString("fr-FR")} → ${etat2.vague2.horlogeFinale.toLocaleString("fr-FR")}`, note: "matière jamais vue, même cortex — la boucle continue sous budget élargi ; départ APRÈS les sondes de phase 1 (horloge MONOTONE, leçon it.70)" },
      ],
      cyclesParEchantillon: CYCLES,
      tailleLot: TAILLE_LOT,
      lrBoost: LR,
      graine: GRAINE,
      horloges: { sondesPhase1: HORLOGE_SONDE_1, vague2Depart: HORLOGE_VAGUE2_DEPART, sondesPhase2: HORLOGE_SONDE_2 },
      seuilAreteSaturee: SEUIL_SATURE,
      homoeostasie: true,
      formatTexte: "Q: <question> R: <réponse charte> — bijections texte offsets 30M et 50M (identiques it.69/70), génération paresseuse lot par lot",
    },
    memoire: {
      avantAllocation: etat1.memoire.avantAllocation,
      apresAllocation: etat1.memoire.apresAllocation,
      plafondRssMo: PLAFOND_RSS_MO,
      picRssMo,
    },
    sources: {
      generateur: "lib/gen3/generateur-datasets.ts — paireGenere (bijection texte, espace ≥ 141,9 M/domaine, offsets anti-rejoue)",
      mecanique: "lib/neural/training/entrainement-ondes.ts — entrainerDomainesParOndes (EOD it.57/63 inchangée)",
      substrat: "lib/neural/core/v2/cortex-columnnaire.ts — CortexColumnnaire (homéostasie it.67/68 activée, budget 8.0)",
    },
    entrainement: {
      vague1: {
        echantillons: etat1.vague1.echantillonsTraites,
        dureeMs: etat1.vague1.dureeMs,
        horlogeFinale: etat1.vague1.horlogeFinale,
      },
      vague2: {
        echantillons: etat2.vague2.echantillonsTraites,
        dureeMs: etat2.vague2.dureeMs,
        horlogeFinale: etat2.vague2.horlogeFinale,
      },
      metabolisme: etat3.metabolismeGlobal,
      mesuresStabilite: mesures,
    },
    bilan: {
      criteres: {
        c1_donnees_fraises: {
          vague1: { valeur: c1v1, sur: 19, seuil: FRAIS_PAR_DOMAINE, atteint: c1v1 === 19 },
          vague2: { valeur: c1v2, sur: 19, seuil: FRAIS_PAR_DOMAINE, atteint: c1v2 === 19 },
          atteint: c1v1 === 19 && c1v2 === 19,
        },
        c2_renforts_positifs: {
          vague1: { valeur: c2v1, sur: 19, atteint: c2v1 === 19 },
          vague2: { valeur: c2v2, sur: 19, atteint: c2v2 === 19 },
          atteint: c2v1 === 19 && c2v2 === 19,
        },
        c3_budget_elargi: {
          valeur: c3,
          sur: 19,
          baseline: "substrat neuf (sémantique it.66/69), budget 8.0 — comparaison croisée avec l'artefact commis it.70 (14/19 sous budget 6.0, même matière offset 30M)",
          atteint: c3 === 19,
        },
        c3b_boucle_continue: {
          valeur: c3b,
          sur: 19,
          baseline: "état après vague 1 (sémantique documentée — gain marginal d'une vague neuve sur substrat entraîné), budget 8.0 — ancrage it.70 : 6/19 sous budget 6.0",
          atteint: c3b === 19,
        },
        survie_memoire: {
          valeur: survieCount,
          sur: 19,
          baseline: "trace vague 1 après vague 1 vs après vague 2 — ancrage it.70 : 13/19 sous budget 6.0",
          atteint: survieCount === 19,
        },
        c4_stabilite: {
          ratioTransmissionsVague1: Math.round(ratioV1 * 1000) / 1000,
          ratioTransmissionsVague2: Math.round(ratioV2 * 1000) / 1000,
          seuil: 3,
          aretesSatureesFin: mesures.length > 0 ? mesures[mesures.length - 1]!.aretesSaturees : 0,
          poidsMaxFin: mesures.length > 0 ? mesures[mesures.length - 1]!.poidsMax : 0,
          normalisationsTotales: etat3.metabolismeGlobal.normalisations,
          atteint: ratioV1 < 3 && ratioV2 < 3,
        },
      },
      limitesHonnetes: [
        "ceci n'est PAS un rejeu bit-exact : le budget homéostatique 8.0 change l'état du cortex — la comparabilité vient de l'expérience contrôlée (même matière offsets 30M/50M, même graine, même protocole EOD, SEULE variable = budget) et de l'ancrage COMMIS it.70 (boucle-continue-it70.json : C3a 14/19, C3b 6/19, survie 13/19 sous budget 6.0)",
        "le C3b mesure le gain d'une vague NEUVE sur un substrat DÉJÀ ENTRAÎNÉ (baseline = état après vague 1) — ce n'est PAS la sémantique it.66/69 (substrat neuf) : les deux nombres ne sont pas interchangeables, l'ancrage de comparabilité intra-artefact est le C3 (scratch → après vague 1)",
        "la carte des interférences est STRUCTURELLE (indépendante du budget : analyserOndeTexte/colonnesDepuisOndes ne lisent pas les poids) — elle n'est pas re-mesurée ici, l'artefact commis it.70 fait foi (autoPorteur ≈ 0, interférences croisées 0,40–0,55)",
        "le CHAMP cortical (bus inter-régions) est par vague — pas de rétroaction champ→cortex : le substrat est l'objet continu ; la campagne est REPRENABLE par checkpoints binaires du cortex (structure reconstruite depuis la graine, poids restaurés bit à bit), chaque échantillon entraîné UNE fois",
        "la trace reste une mesure interne du substrat sparse-colonne — elle ne prétend pas mesurer une qualité linguistique externe ; les réponses de gen3 en production viennent du PONT VOCATION (rôles distincts, it.66) ; le runtime de production reste 2^20 (VPS 2 Go) — la portée est la PREUVE de discrimination et de continuité",
        "le facteur de branchement effectif augmente avec le budget (≤ 6 → ≤ 8 par spike) : une avalanche serait détectée par C4 (deltas qui explosent), la durée par lot et le RSS (garde-fou abort honnête) — le risque est ACCEPTÉ et MESURÉ, pas supposé absent",
      ],
    },
    parDomaine,
    pointsDeSonde: {
      vague1: detailPointsV1,
      vague2: detailPointsV2,
    },
  };

  if (!existsSync(join(process.cwd(), "assets/neural-pretrained"))) {
    mkdirSync(join(process.cwd(), "assets/neural-pretrained"), { recursive: true });
  }
  const cheminTmp = cheminArtefact + ".tmp";
  writeFileSync(cheminTmp, JSON.stringify(artefact, null, 2));
  renameSync(cheminTmp, cheminArtefact);

  log(`ARTEFACT commis : ${cheminArtefact}`);
  log(`C1 frais v1 ${c1v1}/19 · v2 ${c1v2}/19 · C2 renforts v1 ${c2v1}/19 · v2 ${c2v2}/19 · C3 ${c3}/19 · C3b ${c3b}/19 · survie ${survieCount}/19 · C4 ratios ${ratioV1.toFixed(3)}/${ratioV2.toFixed(3)} · RSS pic ${picRssMo} Mo`);
  for (const d of parDomaine) {
    log(`  ${d.id.padEnd(26)} bande ${d.bandeVocab} · C3 ${d.c3.toFixed(3)} ${d.c3Atteint ? "✓" : "✗"} · C3b ${d.c3b.toFixed(3)} ${d.c3bAtteint ? "✓" : "✗"} · survie ${d.survie.toFixed(3)} ${d.survieAtteint ? "✓" : "✗"}`);
  }
}

/* ------------------------------------------------------------------ */
/* ORCHESTRATION — exécution PAR SEGMENTS (le contexte d'exécution      */
/* borne chaque appel : chaque segment écrit son checkpoint AVANT de    */
/* s'arrêter, chaque échantillon est entraîné UNE fois)                 */
/*  GEN3IA_IT71_STOP=1      → s'arrête après le checkpoint "1-"         */
/*  GEN3IA_IT71_RESUME=1    → 1b (S1a+S1b) puis 2,3,4                   */
/*  GEN3IA_IT71_RESUME=2    → vague 2 (depuis "1-") puis 3,4            */
/*  GEN3IA_IT71_RESUME=3    → S2a (depuis "2-") puis 4                  */
/*  GEN3IA_IT71_RESUME=4    → S2b + artefact (depuis "3-")              */
/* ------------------------------------------------------------------ */

function main(): void {
  const niveau = Number(process.env.GEN3IA_IT71_RESUME ?? "0");
  const stop = Number(process.env.GEN3IA_IT71_STOP ?? "0") === 1;

  // ---------- Reprise S2b + artefact (niveau 4) ----------
  if (niveau >= 4) {
    log("REPRISE niveau 4 — checkpoint après S2a (S2b + artefact)…");
    const { cortex } = restaurerEtatBinaire("3-");
    const meta3 = JSON.parse(readFileSync(join(DIR_CHECKPOINT, "3-meta.json"), "utf8")) as Record<string, unknown>;
    const etat1 = JSON.parse(readFileSync(CHEMIN_PHASE_A, "utf8")) as EtatPhaseA;
    const etat2 = JSON.parse(readFileSync(join(DIR_CHECKPOINT, "2-meta.json"), "utf8")) as unknown as EtatCkpt2;
    const etat3: EtatCkpt3 = {
      sondesApresV2SurV1: meta3.sondesApresV2SurV1 as EtatCkpt3["sondesApresV2SurV1"],
      mesures: meta3.mesures as MesureBloc[],
      metabolismeGlobal: meta3.metabolismeGlobal as Metabolisme,
    };
    phase4(cortex, etat1, etat2, etat3);
    return;
  }

  // ---------- Reprise S2a (niveau 3) ----------
  if (niveau === 3) {
    log("REPRISE niveau 3 — checkpoint après vague 2 (S2a)…");
    const { cortex } = restaurerEtatBinaire("2-");
    const meta2 = JSON.parse(readFileSync(join(DIR_CHECKPOINT, "2-meta.json"), "utf8")) as Record<string, unknown>;
    const etat2: EtatCkpt2 = {
      vague2: meta2.vague2 as EtatCkpt2["vague2"],
      mesures: meta2.mesures as MesureBloc[],
      metabolismeGlobal: meta2.metabolismeGlobal as Metabolisme,
    };
    const etat3 = phase3(cortex, etat2);
    if (stop) {
      log("STOP demandé — arrêt propre après le checkpoint « 3- ».");
      void etat3;
      return;
    }
    const meta3 = JSON.parse(readFileSync(join(DIR_CHECKPOINT, "3-meta.json"), "utf8")) as Record<string, unknown>;
    const etat1 = JSON.parse(readFileSync(CHEMIN_PHASE_A, "utf8")) as EtatPhaseA;
    const etat3b: EtatCkpt3 = {
      sondesApresV2SurV1: meta3.sondesApresV2SurV1 as EtatCkpt3["sondesApresV2SurV1"],
      mesures: meta3.mesures as MesureBloc[],
      metabolismeGlobal: meta3.metabolismeGlobal as Metabolisme,
    };
    phase4(cortex, etat1, etat2, etat3b);
    void etat3;
    return;
  }

  // ---------- Reprise vague 2 (niveau 2) ----------
  if (niveau === 2) {
    log("REPRISE niveau 2 — checkpoint après vague 1 (vague 2 + S2a + artefact)…");
    const { cortex } = restaurerEtatBinaire("1-");
    const etat1 = JSON.parse(readFileSync(CHEMIN_PHASE_A, "utf8")) as EtatPhaseA;
    const g1 = etat1.metabolismeGlobal;
    const m1 = etat1.vague1.metabolisme;
    g1.evaluees += m1.evaluees;
    g1.reposes += m1.reposes;
    g1.transmissions += m1.transmissions;
    g1.ms = Math.round((g1.ms + m1.ms) * 1000) / 1000;
    g1.normalisations += m1.normalisations;
    const etat2 = phase2(cortex, etat1);
    if (stop) {
      log("STOP demandé — arrêt propre après le checkpoint « 2- ».");
      return;
    }
    const etat3 = phase3(cortex, etat2);
    if (stop) {
      log("STOP demandé — arrêt propre après le checkpoint « 3- ».");
      void etat3;
      return;
    }
    phase4(cortex, etat1, etat2, etat3);
    return;
  }

  // ---------- Reprise 1b (niveau 1) ou exécution complète ----------
  let cortex: CortexColumnnaire;
  let etat1: EtatPhaseA;
  if (niveau === 1) {
    log("REPRISE niveau 1 — checkpoint après vague 1 (S1a + S1b + suite)…");
    const construit = phase1b();
    if (stop) {
      log("STOP demandé — arrêt propre après la phase A complète.");
      return;
    }
    cortex = construit.cortex;
    etat1 = construit.etat;
  } else {
    phase1a();
    if (stop) {
      log("STOP demandé (GEN3IA_IT71_STOP=1) — arrêt propre après le checkpoint « 1- ».");
      return;
    }
    const construit = phase1b();
    cortex = construit.cortex;
    etat1 = construit.etat;
  }

  // Fusion métabolique vague 1 → global (une fois par processus, avant la
  // vague 2 — les cumuls de blocs de la vague 2 partent du vrai total).
  const g1 = etat1.metabolismeGlobal;
  const m1 = etat1.vague1.metabolisme;
  g1.evaluees += m1.evaluees;
  g1.reposes += m1.reposes;
  g1.transmissions += m1.transmissions;
  g1.ms = Math.round((g1.ms + m1.ms) * 1000) / 1000;
  g1.normalisations += m1.normalisations;

  const etat2 = phase2(cortex, etat1);
  const etat3 = phase3(cortex, etat2);
  phase4(cortex, etat1, etat2, etat3);
}

main();
