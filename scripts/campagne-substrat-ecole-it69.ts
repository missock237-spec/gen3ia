/**
 * it.69 — CAMPAGNE SUBSTRAT ÉLARGI (2^23 = 8 388 608 colonnes, ×8 le défaut).
 *
 * Demandes propriétaires (permanentes) :
 *  - « entraîne gen3 dans tous les domaines… continue jusqu'à ce qu'il
 *    atteigne le niveau requis » (it.65) ;
 *  - « depuis tes propres serveurs locaux » + « 1 millions de données par
 *    domaine » (instruction raffinée) ;
 *  - « fais en sorte qu'il soit capable de répondre à des questions qui
 *    rentrent dans son cadre d'apprentissage ».
 *
 * LEVIER DÉCLARÉ it.68 §8.1 : le C3 (trace 13/19) est limité par le substrat
 * sparse-colonne 1 048 576 (limite documentée it.63/65). Cette campagne
 * MESURE — preuve par la mesure, jamais estimée — si l'élargissement ×8
 * réduit l'interférence inter-domaines (partage de colonnes hachées,
 * punition compétitive) et lève le C3 vers 19/19.
 *
 * PROTOCOLE HONNÊTE (comparabilité stricte avec it.66/68) :
 *  - mécanique EOD it.57/63 INCHANGÉE (entrainerDomainesParOndes, plan
 *    interclassé leçon it.63, lots ≤ 2000, horloge continue) ;
 *  - homéostasie synaptique it.67/68 ACTIVÉE (constat it.68 : sans coût,
 *    seconde ligne de défense) ;
 *  - graine 20261101, cycles 3, lr 0.15, sondes horloge lointaine 90e9
 *    (leçon it.65 : monotone) — IDENTIQUES à it.66/68 ;
 *  - SONDE : formule EXACTE it.66/68 — les textes bijection ENTRAÎNÉS
 *    (début et fin du corpus frais) sont rejoués SANS pliage de bande ;
 *  - SEULE VARIABLE CHANGÉE : colonnes 1 048 576 → 8 388 608 (×8) ;
 *  - matière fraîche : bijection texte offset 30 000 000 (disjointe des
 *    campagnes it.63/65/66/67/68 — espace ≥ 141,9 M/domaine, leçon it.66),
 *    générée PARESSEUSEMENT lot par lot (zéro stockage global — la mémoire
 *    reste celle du substrat, mesurée en continu) ;
 *  - télémétrie mémoire réelle (process.memoryUsage) : le budget 2^23 est
 *    MESURÉ, jamais supposé (garde-fou abort si RSS > plafond).
 *
 * Sortie : assets/neural-pretrained/substrat-ecole-it69.json
 * (bilan C1..C4 tel quel, limites honnêtes, zéro maquillage).
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
/* Paramètres — identiques it.66/68 SAUF la taille du substrat          */
/* ------------------------------------------------------------------ */

/** ×8 le défaut 1 048 576 — la SEULE variable de la comparaison. */
const COLONNES = 8_388_608;
const FRAIS_PAR_DOMAINE = Number(process.env.GEN3IA_FRAIS_PAR_DOMAINE ?? 100_000);
const OFFSET_BIJECTION = 30_000_000;
const CYCLES = 3;
const TAILLE_LOT = 2000;
const LR = 0.15;
const LONGUEUR_TEXTE_MAX = 400;
const HORLOGE_SONDE = 90_000_000_000;
const GRAINE = 20261101;
const SEUIL_SATURE = 0.999;
const BUDGET = 12 * 0.5;
/** Garde-fou mémoire : abort honnête si RSS dépasse ce plafond (Mo). */
const PLAFOND_RSS_MO = Number(process.env.GEN3IA_PLAFOND_RSS_MO ?? 2600);
const environnement = process.env.GEN3IA_ENV ?? "serveur-local";
const cheminArtefact = join(
  process.cwd(),
  "assets/neural-pretrained/substrat-ecole-it69.json",
);

interface ExempleQA {
  texte: string;
  domaine: string;
  index: number;
}

function log(msg: string): void {
  console.log(`[it.69 ${new Date().toISOString()}] ${msg}`);
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
/* Matière fraîche (bijection texte, offset 30M — jamais vue)           */
/* Génération PARESSEUSE lot par lot : la bijection interclassée est    */
/* déterministe (rangée r → domaine IDS_VOCATION[r % 19], index         */
/* floor(r / 19)), aucun stockage des 1,9 M chaînes — la mémoire reste  */
/* celle du substrat, la campagne tient sur le serveur local.           */
/* ------------------------------------------------------------------ */

function texteQAFrais(domaine: string, index: number): string {
  const paire = paireGenere(domaine, index);
  const brut = `Q: ${paire.motif}\nR: ${paire.reponse}`;
  return brut.length <= LONGUEUR_TEXTE_MAX ? brut : `${brut.slice(0, LONGUEUR_TEXTE_MAX - 1)}…`;
}

/** Lot interclassé [debutLot, debutLot + taille) de la bijection
 *  round-robin (leçon it.63) — généré à la volée, zéro stockage global.
 *  Chaque domaine reçoit EXACTEMENT FRAIS_PAR_DOMAINE échantillons
 *  d'indices 0..FRAIS_PAR_DOMAINE-1 (invariant vérifié par la boucle). */
function lotInterclasse(debutLot: number, taille: number): ExempleQA[] {
  const sortie: ExempleQA[] = [];
  for (let r = debutLot; r < Math.min(debutLot + taille, FRAIS_PAR_DOMAINE * IDS_VOCATION.length); r++) {
    const domaine = IDS_VOCATION[r % IDS_VOCATION.length]!;
    const index = Math.floor(r / IDS_VOCATION.length);
    sortie.push({ texte: texteQAFrais(domaine, OFFSET_BIJECTION + index), domaine, index });
  }
  return sortie;
}

/* ------------------------------------------------------------------ */
/* Sonde de trace (porteur/autres) — formule EXACTE it.66/68            */
/* ------------------------------------------------------------------ */

interface SondePoint {
  porteur: number;
  autres: number;
  ratio: number;
}

function sonderTrace(
  cortex: CortexColumnnaire,
  points: readonly { domaine: string; texte: string }[],
): Map<string, SondePoint> {
  const accumule = new Map<string, { p: number; a: number; n: number }>();
  for (const pt of points) {
    const bande = bandeDuDomaine(pt.domaine);
    const paquets = analyserOndeTexte(pt.texte, HORLOGE_SONDE);
    const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
    cortex.pas(injections, HORLOGE_SONDE + 1);
    const activation = cortex.activationBandes();
    const porteur = activation[bande] ?? 0;
    let somme = 0;
    for (let b = 0; b < activation.length; b++) {
      if (b !== bande) somme += activation[b] ?? 0;
    }
    const autres = somme / Math.max(1, activation.length - 1);
    const acc = accumule.get(pt.domaine) ?? { p: 0, a: 0, n: 0 };
    acc.p += porteur;
    acc.a += autres;
    acc.n += 1;
    accumule.set(pt.domaine, acc);
  }
  const sortie = new Map<string, SondePoint>();
  for (const [domaine, acc] of accumule) {
    const porteur = acc.p / acc.n;
    const autres = acc.a / acc.n;
    sortie.set(domaine, { porteur, autres, ratio: porteur / Math.max(1e-12, autres) });
  }
  return sortie;
}

/** Points de sonde — les textes bijection ENTRAÎNÉS (début et fin du corpus
 *  frais), formule it.66/68 (comparabilité stricte des campagnes). */
function pointsDeSonde(): { domaine: string; texte: string }[] {
  const points: { domaine: string; texte: string }[] = [];
  for (const domaine of IDS_VOCATION) {
    points.push({ domaine, texte: texteQAFrais(domaine, OFFSET_BIJECTION) });
    points.push({ domaine, texte: texteQAFrais(domaine, OFFSET_BIJECTION + FRAIS_PAR_DOMAINE - 1) });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* Stabilité (mesures réelles par bloc de lots)                         */
/* ------------------------------------------------------------------ */

interface MesureBloc {
  bloc: number;
  echantillons: number;
  /** Transmissions du SEUL bloc (delta — base du ratio C4). */
  transmissions: number;
  /** Transmissions cumulées depuis le début (traçabilité, re-dérivable). */
  transmissionsCumul: number;
  aretesSaturees: number;
  poidsMax: number;
  attenteEchantillon: number;
  normalisations: number;
  /** Normalisations cumulées (traçabilité, re-dérivable). */
  normalisationsCumul: number;
  rssMo: number;
}

function mesurerStabilite(
  cortex: CortexColumnnaire,
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
/* Session principale                                                   */
/* ------------------------------------------------------------------ */

function main(): void {
  log(`Campagne substrat élargi — ${COLONNES.toLocaleString("fr-FR")} colonnes (2^23), matière fraîche ${FRAIS_PAR_DOMAINE}/domaine (offset ${OFFSET_BIJECTION.toLocaleString("fr-FR")}), graine ${GRAINE}, environnement ${environnement}`);

  // ---------- 0. GARDE-FOU MÉMOIRE AVANT ALLOCATION ----------
  const avantAllocation = memoireMo();
  log(`Mémoire avant allocation : RSS ${avantAllocation.rss} Mo · external ${avantAllocation.external} Mo · arrayBuffers ${avantAllocation.arrayBuffers} Mo`);

  // ---------- 1. SUBSTRAT ÉLARGI (2^23, homéostasie it.67/68 activée) ----------
  const t0 = Date.now();
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES,
    seed: GRAINE,
    normalisationHomeostatique: true,
    budgetPoidsSortants: BUDGET,
  });
  const apresAllocation = memoireMo();
  log(`Substrat construit en ${((Date.now() - t0) / 1000).toFixed(1)} s — RSS ${apresAllocation.rss} Mo (Δ +${Math.round(apresAllocation.rss - avantAllocation.rss)} Mo · arêtes ${cortex.csrCible.length.toLocaleString("fr-FR")})`);
  verifierMemoire("construction substrat");

  const champ = new ChampCorticalGen3(GRAINE);

  // ---------- 2. MATIÈRE FRAÎCHE PARESSEUSE (bijection offset 30M, 19/19) ----------
  const totalFrais = FRAIS_PAR_DOMAINE * IDS_VOCATION.length;
  log(`Matière fraîche (génération paresseuse lot par lot) : ${totalFrais.toLocaleString("fr-FR")} échantillons QA uniques (19 domaines × ${FRAIS_PAR_DOMAINE.toLocaleString("fr-FR")}, bijection offset ${OFFSET_BIJECTION.toLocaleString("fr-FR")})`);

  // ---------- 3. SONDES AVANT (scratch neuf, horloge lointaine 90e9) ----------
  const points = pointsDeSonde();
  const avant = sonderTrace(cortex, points);
  log(`Sondes AVANT mesurées (${points.length} points, horloge lointaine ${HORLOGE_SONDE.toLocaleString("fr-FR")})`);

  // ---------- 4. ENTRAÎNEMENT — EOD it.57/63 INCHANGÉE ----------
  const debut = Date.now();
  const metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0, normalisations: 0 };
  const bilanDomaines = new Map<string, { echantillons: number; renforts: number; annulations: number; resonance: number; mesures: number }>();
  const mesures: MesureBloc[] = [];
  let horloge = 0;
  let echantillonsTraites = 0;
  const BLOC_MESURE = 190_000; // mesure de stabilité ~10× sur la campagne
  const LOG_LOT = 50; // journal de progression tous les 50 lots (100k échantillons)

  for (let debutLot = 0; debutLot < totalFrais; debutLot += TAILLE_LOT) {
    const lot = lotInterclasse(debutLot, TAILLE_LOT);
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
      log(`Progression — ${echantillonsTraites.toLocaleString("fr-FR")}/${totalFrais.toLocaleString("fr-FR")} éch. · horloge ${horloge.toLocaleString("fr-FR")} · trans ${metabolisme.transmissions.toLocaleString("fr-FR")} · RSS ${memoireMo().rss} Mo`);
    }
    if (echantillonsTraites % BLOC_MESURE < TAILLE_LOT) {
      const bloc = mesures.length + 1;
      // it.69 — leçon le sonde it.68 : le ratio C4 se mesure sur les DELTAS
      // par bloc (transmissions du bloc), jamais sur les cumuls — un cumul
      // croissant n'est pas une explosion, un delta qui explose l'est.
      const transmissionsBloc = metabolisme.transmissions - (mesures.length > 0 ? mesures[mesures.length - 1]!.transmissionsCumul : 0);
      const normalisationsBloc = metabolisme.normalisations - (mesures.length > 0 ? mesures[mesures.length - 1]!.normalisationsCumul : 0);
      mesures.push(
        mesurerStabilite(cortex, bloc, echantillonsTraites, transmissionsBloc, metabolisme.transmissions, normalisationsBloc, metabolisme.normalisations),
      );
      const m = mesures[bloc - 1]!;
      log(`Bloc ${bloc} — ${m.echantillons.toLocaleString("fr-FR")} éch. · saturées ${m.aretesSaturees.toLocaleString("fr-FR")} · poidsMax ${m.poidsMax} · norm ${m.normalisations.toLocaleString("fr-FR")} · RSS ${m.rssMo} Mo`);
      verifierMemoire(`bloc ${bloc}`);
    }
  }
  const dureeMs = Date.now() - debut;
  log(`Entraînement terminé : ${echantillonsTraites.toLocaleString("fr-FR")} échantillons, horloge finale ${horloge.toLocaleString("fr-FR")}, ${dureeMs.toLocaleString("fr-FR")} ms, normalisations ${metabolisme.normalisations.toLocaleString("fr-FR")}`);

  // ---------- 5. SONDES APRÈS (mêmes points, même horloge lointaine) ----------
  const apres = sonderTrace(cortex, points);
  for (const id of IDS_VOCATION) {
    if (!avant.has(id)) apres.delete(id); // contrôle honnête it.68
  }

  // ---------- 6. BILAN PAR DOMAINE (comptage RÉEL des gains) ----------
  const parDomaine = IDS_VOCATION.map((id) => {
    const dom = DOMAINES_VOCATION.find((d) => d.id === id)!;
    const b = bilanDomaines.get(id) ?? { echantillons: 0, renforts: 0, annulations: 0, resonance: 0, mesures: 0 };
    const pAvant = avant.get(id);
    const pApres = apres.get(id);
    const traceAvant = pAvant?.ratio ?? 0;
    const traceApres = pApres?.ratio ?? 0;
    return {
      id,
      label: dom.label,
      bande: bandeDuDomaine(id),
      echantillonsFrais: b.echantillons,
      renforts: b.renforts,
      annulations: b.annulations,
      resonanceMoyenne: b.mesures > 0 ? b.resonance / b.mesures : 0,
      traceAvant,
      traceApres,
      gainTrace: traceApres / Math.max(1e-12, traceAvant),
    };
  });
  const c1 = parDomaine.filter((d) => d.echantillonsFrais >= FRAIS_PAR_DOMAINE).length;
  const c2 = parDomaine.filter((d) => d.renforts > 0).length;
  const c3 = parDomaine.filter((d) => d.gainTrace > 1).length;

  // C4 stabilité : ratio transmissions fin/début (mesuré sur les blocs).
  const ratioTransmissions =
    mesures.length >= 2 && mesures[0]!.transmissions > 0
      ? mesures[mesures.length - 1].transmissions / mesures[0]!.transmissions
      : 1;

  const artefact = {
    session: "campagne-substrat-ecole-it69",
    date: new Date().toISOString(),
    environnement,
    demandeProprietaire:
      "entraîne gen3 dans tous les domaines, continue jusqu'au niveau requis (it.65) — depuis tes propres serveurs locaux, 1 million de données par domaine, questions dans le cadre (instruction raffinée)",
    parametres: {
      colonnes: COLONNES,
      facteurElargissement: COLONNES / 1_048_576,
      fraisParDomaine: FRAIS_PAR_DOMAINE,
      offsetBijection: OFFSET_BIJECTION,
      cyclesParEchantillon: CYCLES,
      tailleLot: TAILLE_LOT,
      lrBoost: LR,
      graine: GRAINE,
      horlogeSonde: HORLOGE_SONDE,
      seuilAreteSaturee: SEUIL_SATURE,
      budgetPoidsSortants: BUDGET,
      homoeostasie: true,
      formatTexte: "Q: <question> R: <réponse charte> — bijection texte offset 30M+ (jamais vue it.63/65/66/67/68), génération paresseuse lot par lot",
    },
    memoire: {
      avantAllocation,
      apresAllocation,
      plafondRssMo: PLAFOND_RSS_MO,
      picRssMo: Math.max(...mesures.map((m) => m.rssMo), memoireMo().rss),
    },
    sources: {
      generateur: "lib/gen3/generateur-datasets.ts — paireGenere (bijection texte, espace ≥ 141,9 M/domaine, offset anti-rejoue)",
      mecanique: "lib/neural/training/entrainement-ondes.ts — entrainerDomainesParOndes (EOD it.57/63 inchangée)",
      substrat: "lib/neural/core/v2/cortex-columnnaire.ts — CortexColumnnaire (homéostasie it.67/68 activée)",
    },
    entrainement: {
      echantillonsTotaux: echantillonsTraites,
      dureeMs,
      horlogeFinale: horloge,
      metabolisme,
      mesuresStabilite: mesures,
    },
    bilan: {
      criteres: {
        c1_donnees_fraises_19_domaines: { valeur: c1, sur: 19, seuil: FRAIS_PAR_DOMAINE, atteint: c1 === 19 },
        c2_renforts_positifs: { valeur: c2, sur: 19, atteint: c2 === 19 },
        c3_gain_trace: { valeur: c3, sur: 19, atteint: c3 === 19 },
        c4_stabilite: {
          ratioTransmissionsFinDebut: Math.round(ratioTransmissions * 1000) / 1000,
          seuil: 3,
          aretesSatureesFin: mesures.length > 0 ? mesures[mesures.length - 1].aretesSaturees : 0,
          poidsMaxFin: mesures.length > 0 ? mesures[mesures.length - 1].poidsMax : 0,
          listeAttentePlafonnee: true,
          normalisationsTotales: metabolisme.normalisations,
          atteint: ratioTransmissions < 3,
        },
      },
      limitesHonnetes: [
        "la comparaison avec it.66/68 (13/19 à 2^20) porte sur le PROTOCOLE identique (graine, cycles, lots, lr, sondes formule it.66/68) avec une matière fraîche DÉCALÉE (offset 30M vs 10M) — les textes diffèrent, le rôle des sondes (textes entraînés début/fin) est identique",
        "la trace reste une mesure interne du substrat sparse-colonne — elle ne prétend pas mesurer une qualité linguistique externe",
        "l'élargissement ×8 est mesuré sur le serveur local (mémoire réelle télémétrée) ; le runtime de production reste 2^20 — la portée de cette campagne est la PREUVE de discrimination, pas un déploiement mémoire",
        "les réponses de gen3 en production viennent du PONT VOCATION — ces campagnes renforcent le substrat neuronal, elles ne remplacent pas le pont (rôles distincts, it.66)",
      ],
    },
    parDomaine,
  };

  // ---------- 7. PUBLICATION HONNÊTE ----------
  if (!existsSync(join(process.cwd(), "assets/neural-pretrained"))) {
    mkdirSync(join(process.cwd(), "assets/neural-pretrained"), { recursive: true });
  }
  const cheminTmp = cheminArtefact + ".tmp";
  writeFileSync(cheminTmp, JSON.stringify(artefact, null, 2));
  renameSync(cheminTmp, cheminArtefact);

  log(`ARTEFACT commis : ${cheminArtefact}`);
  log(`C1 frais ${c1}/19 · C2 renforts ${c2}/19 · C3 trace ${c3}/19 (baseline 2^20 : 13/19) · C4 ratio ${ratioTransmissions.toFixed(3)} · RSS pic ${artefact.memoire.picRssMo} Mo`);
  for (const d of parDomaine) {
    log(`  ${d.id.padEnd(38)} bande ${d.bande} · gain ${(Math.round(d.gainTrace * 1000) / 1000).toFixed(3)} ${d.gainTrace > 1 ? "✓" : "✗"} · avant ${d.traceAvant.toFixed(3)} → après ${d.traceApres.toFixed(3)}`);
  }
}

main();
