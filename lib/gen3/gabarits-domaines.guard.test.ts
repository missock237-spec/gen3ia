/**
 * GARDE 41ᵉ (it.72) — LA MATIÈRE DIFFÉRENCIÉE EST MESURÉE HONNÊTEMENT :
 * LE LEVIER DE COLLISION EST RÉEL (−73,2 %), LA RÉFUTATION DU C3 EST
 * PUBLIÉE TELLE QUELLE, LA BIJECTION it.65 RESTE FIGÉE BIT À BIT.
 *
 * Demandes propriétaires : « entraîne gen3 dans tous les domaines…
 * continue jusqu'à ce qu'il atteigne le niveau requis » + « un système
 * qui apprend du générateur de dataset, pour qu'il puisse toujours
 * continuer à s'améliorer en continu » (it.65) + « depuis tes propres
 * serveurs locaux, 1 million de données par domaine » (raffinée).
 *
 * La campagne it.72 exécute le candidat №1 déclaré it.71 §7.1
 * (« exploiter la carte des interférences : matière différenciée par
 * gabarits ») — expérience CONTRÔLÉE à variable unique : même substrat
 * (2^23, budget 8.0, homéostasie ON, graine 20261101), même mécanique
 * EOD it.57/63, mêmes horloges monotones — SEULE VARIABLE : la MATIÈRE
 * (lib/gen3/gabarits-domaines.ts : fenêtre de gabarits rotée par
 * l'indice charte + tranches rotées des lexiques génériques). L'ancrage
 * gabarits partagés est l'artefact COMMIS it.71 (plafond-leve-it71.json :
 * C3 14/19, C3b 12/19, survie 13/19). RÉSULTAT MESURÉ ET PUBLIÉ TEL
 * QUEL : le levier de collision est RÉEL (0,191 → 0,051, −73,2 %) mais
 * le C3 ne monte PAS (13/19) — TROISIÈME réfutation indépendante du
 * plafond du C3 (budget it.71, substrat it.69, gabarits it.72) : les
 * échecs C3 suivent les ratios SCRATCH élevés (régression vers la
 * moyenne), et l'équilibre de saturation est MATIÈRE-INDÉPENDANT
 * (2 358 856 arêtes, identique it.71 au millième).
 *
 * Verrous :
 *  1. SESSION + VARIABLE UNIQUE : matière différenciée déclarée (ancre
 *     budget 8.0 it.71), substrat 2^23 réel, homéostasie ON, graine ;
 *  2. HORLOGES MONOTONES : 0 < 90e9 < 90,01e9 < fin vague 2 < 90,03e9 ;
 *  3. NOUVELLE FAMILLE : offsets 70M/80M déclarés, 1 900 000 échantillons
 *     par vague comptés par domaine, renforts > 0 partout ;
 *  4. LEVIER DE COLLISION : avant > après pour les 19 domaines, moyenne
 *     re-dérivable, réduction ≥ 50 % exigée — le canal d'interférence
 *     mesuré it.70 §3.4 est réellement réduit ;
 *  5. BIJECTION it.65 FIGÉE : deux ancres figées (texteGenere bit à bit)
 *     — les artefacts commis it.65/69/70/71 restent reproductibles ;
 *  6. NOUVELLE BIJECTION SÛRE : unicité (zéro doublon sur l'échantillon),
 *     ancrage CHARTE (label + taches/motsCles/outils présents dans chaque
 *     texte — zéro invention), espace combinatoire ≥ 10⁶/domaine (les 19) ;
 *  7. C3 = 13/19, C3b = 10/19, SURVIE = 9/19 : COMPTAGES RÉELS
 *     re-dérivables des traces à 6 décimales, échecs NOMMÉS, atteint
 *     = false exigé (le niveau requis 19/19 n'est PAS déclaré atteint) ;
 *  8. STABILITÉ : C4 < 3, aucun delta n'explose, NORMALISATIONS = 0,
 *     poidsMax ≤ 1, arêtes saturées fin = 2 358 856 (équilibre
 *     matière-indépendant — fait mesuré clé it.72) ;
 *  9. TRACES PAR POINT : 38 points par vague, cohérents avec les
 *     moyennes (tolérance de ré-arrondi) ;
 * 10. HONNÊTETÉ : ≥ 5 limites présentes (non-comparabilité bit à bit,
 *     bijection it.65 figée, mots de fonction vs faits de domaine, pont
 *     vocation), ordre charte, échecs visibles (zéro gonflage).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_VOCATION, DOMAINES_VOCATION } from "./vocation";
import { texteGenere, lexiqueDuDomaine } from "./generateur-datasets";
import {
  texteDomaine,
  paireDomaine,
  rotationGabarit,
  espaceCombinatoireDomaine,
  indiceCharte,
} from "./gabarits-domaines";

const CHEMIN = join(
  process.cwd(),
  "assets/neural-pretrained/gabarits-domaines-it72.json",
);

/** Les 6 échecs C3 mesurés it.72 (publiés tels quels — la comparaison
 *  croisée avec l'ancre it.71 montre la REDISTRIBUTION : 2 échecs
 *  historiques guéris, 2 domaines jusque-là verts basculés). */
const ECHECS_C3_IT72 = [
  "recherche-web",
  "analyse-documents",
  "medecine-sante",
  "commerce-economie",
  "ingenierie-industrie",
  "droit-administration",
] as const;

/** ANCRE FIGÉE it.65 — la bijection historique ne doit JAMAIS bouger
 *  (les artefacts commis it.65/69/70/71 restent reproductibles bit à
 *  bit). Toute modification de generateur-datasets.ts casse ces chaînes. */
const ANCRE_IT65_RECHERCHE_WEB_0 =
  "gen3 — veille thématique et concurrentielle : recherche web (web.search) ; synthèse 2024 pour un résultat précis sur 12 éléments (Recherche web).";
const ANCRE_IT65_AGRICULTURE_123456 =
  "gen3 — conseil cultural et calendrier agricole : agriculture (knowledge.search) ; fiche T3 2026 pour un résultat chiffré sur 36 éléments (Agriculture et environnement).";

interface ArtefactIt72 {
  session: string;
  parametres: {
    colonnes: number;
    budgetPoidsSortants: number;
    budgetAncreIt71: number;
    seuleVariable: string;
    vagues: Array<{ vague: number; offsetBijection: number; fraisParDomaine: number; horloges: string }>;
    cyclesParEchantillon: number;
    tailleLot: number;
    lrBoost: number;
    graine: number;
    horloges: { sondesPhase1: number; vague2Depart: number; sondesPhase2: number };
    homoeostasie: boolean;
  };
  memoire: {
    avantAllocation: { rss: number };
    apresAllocation: { rss: number };
    plafondRssMo: number;
    picRssMo: number;
  };
  sources: Record<string, string>;
  levierGabarits: {
    methode: string;
    collisionMoyenneAvant: number;
    collisionMoyenneApres: number;
    reductionPct: number;
    parDomaine: Array<{ id: string; avant: number; apres: number }>;
  };
  entrainement: {
    vague1: { echantillons: number; dureeMs: number; horlogeFinale: number };
    vague2: { echantillons: number; dureeMs: number; horlogeFinale: number };
    metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number; normalisations: number };
    mesuresStabilite: Array<{
      vague: 1 | 2;
      bloc: number;
      echantillons: number;
      transmissions: number;
      transmissionsCumul: number;
      aretesSaturees: number;
      poidsMax: number;
      normalisations: number;
      normalisationsCumul: number;
      rssMo: number;
    }>;
  };
  bilan: {
    criteres: {
      c1_donnees_fraises: {
        vague1: { valeur: number; sur: number; seuil: number; atteint: boolean };
        vague2: { valeur: number; sur: number; seuil: number; atteint: boolean };
        atteint: boolean;
      };
      c2_renforts_positifs: {
        vague1: { valeur: number; sur: number; atteint: boolean };
        vague2: { valeur: number; sur: number; atteint: boolean };
        atteint: boolean;
      };
      levier_collision: {
        collisionMoyenneAvant: number;
        collisionMoyenneApres: number;
        reductionPct: number;
        seuilReductionPct: number;
        atteint: boolean;
      };
      c3_gabarits_diff: { valeur: number; sur: number; baseline: string; atteint: boolean };
      c3b_boucle_continue: { valeur: number; sur: number; baseline: string; atteint: boolean };
      survie_memoire: { valeur: number; sur: number; baseline: string; atteint: boolean };
      c4_stabilite: {
        ratioTransmissionsVague1: number;
        ratioTransmissionsVague2: number;
        seuil: number;
        aretesSatureesFin: number;
        poidsMaxFin: number;
        normalisationsTotales: number;
        atteint: boolean;
      };
    };
    limitesHonnetes: string[];
  };
  parDomaine: Array<{
    id: string;
    label: string;
    bandeVocab: number;
    collisionAvant: number | null;
    collisionApres: number | null;
    echantillonsVague1: number;
    renfortsVague1: number;
    echantillonsVague2: number;
    renfortsVague2: number;
    traceScratchV1: number;
    traceApresVague1: number;
    c3: number;
    c3Atteint: boolean;
    traceAvantVague2: number;
    traceApresVague2: number;
    c3b: number;
    c3bAtteint: boolean;
    traceApresVague2SurVague1: number;
    survie: number;
    survieAtteint: boolean;
  }>;
  pointsDeSonde: {
    vague1: Array<{ domaine: string; indice: string; ratioScratch: number; ratioApresVague1: number; ratioApresVague2: number }>;
    vague2: Array<{ domaine: string; indice: string; ratioAvantVague2: number; ratioApresVague2: number }>;
  };
}

let artefact: ArtefactIt72 | null = null;

function charger(): ArtefactIt72 {
  if (artefact) return artefact;
  expect(existsSync(CHEMIN), `artefact manquant : ${CHEMIN}`).toBe(true);
  artefact = JSON.parse(readFileSync(CHEMIN, "utf8")) as ArtefactIt72;
  return artefact;
}

describe("garde 41ᵉ — matière différenciée it.72", () => {
  it("l'artefact existe et déclare la session it.72 avec la VARIABLE UNIQUE (matière, ancre budget 8.0 it.71)", () => {
    const a = charger();
    expect(a.session).toBe("campagne-gabarits-domaines-it72");
    expect(a.parametres.budgetPoidsSortants).toBe(8.0);
    expect(a.parametres.budgetAncreIt71).toBe(8.0);
    expect(a.parametres.seuleVariable).toContain("MATIÈRE");
    expect(a.parametres.seuleVariable).toContain("gabarits-domaines");
    expect(a.parametres.seuleVariable).toContain("identique à it.71");
    expect(a.parametres.homoeostasie).toBe(true);
    expect(a.parametres.graine).toBe(20261101);
    expect(a.parametres.cyclesParEchantillon).toBe(3);
    expect(a.parametres.tailleLot).toBe(2000);
    expect(a.parametres.lrBoost).toBe(0.15);
    expect(a.sources.substrat).toContain("cortex-columnnaire");
    expect(a.sources.mecanique).toContain("entrainement-ondes");
    expect(a.sources.generateur).toContain("gabarits-domaines");
    expect(a.sources.generateur).toContain("FIGÉE bit à bit");
  });

  it("substrat 2^23 RÉEL (mémoire > 700 Mo), plafond RSS respecté, horloges MONOTONES (leçon it.70/71)", () => {
    const a = charger();
    expect(a.parametres.colonnes).toBe(8_388_608);
    expect(a.memoire.apresAllocation.rss).toBeGreaterThan(700);
    expect(a.memoire.plafondRssMo).toBe(2600);
    expect(a.memoire.picRssMo).toBeLessThanOrEqual(a.memoire.plafondRssMo);
    const h = a.parametres.horloges;
    expect(h.sondesPhase1).toBe(90_000_000_000);
    expect(h.vague2Depart).toBe(90_010_000_000);
    expect(h.sondesPhase2).toBe(90_030_000_000);
    expect(0).toBeLessThan(h.sondesPhase1);
    expect(h.sondesPhase1).toBeLessThan(h.vague2Depart);
    expect(h.vague2Depart).toBeLessThan(a.entrainement.vague2.horlogeFinale);
    expect(a.entrainement.vague2.horlogeFinale).toBeLessThan(h.sondesPhase2);
  });

  it("nouvelle FAMILLE : offsets 70M/80M déclarés, 1 900 000 échantillons par vague comptées par domaine, renforts > 0 partout", () => {
    const a = charger();
    const vagues = a.parametres.vagues;
    expect(vagues).toHaveLength(2);
    expect(vagues[0]!.vague).toBe(1);
    expect(vagues[0]!.offsetBijection).toBe(70_000_000);
    expect(vagues[1]!.vague).toBe(2);
    expect(vagues[1]!.offsetBijection).toBe(80_000_000);
    for (const v of vagues) expect(v.fraisParDomaine).toBe(100_000);
    expect(a.entrainement.vague1.echantillons).toBe(1_900_000);
    expect(a.entrainement.vague2.echantillons).toBe(1_900_000);
    for (const d of a.parDomaine) {
      expect(d.echantillonsVague1).toBe(100_000);
      expect(d.echantillonsVague2).toBe(100_000);
      expect(d.renfortsVague1).toBeGreaterThan(0);
      expect(d.renfortsVague2).toBeGreaterThan(0);
    }
  });

  it("LEVIER DE COLLISION : avant > après pour les 19 domaines, moyenne re-dérivable, réduction ≥ 50 %", () => {
    const a = charger();
    const lev = a.levierGabarits;
    expect(lev.collisionMoyenneAvant).toBeGreaterThan(lev.collisionMoyenneApres);
    expect(lev.reductionPct).toBeGreaterThanOrEqual(50);
    expect(lev.collisionMoyenneApres).toBeGreaterThan(0);
    // Re-dérivation de la moyenne depuis le détail par domaine (arrondi 1e-6).
    const sommeAvant = lev.parDomaine.reduce((s, x) => s + (x.avant ?? 0), 0) / lev.parDomaine.length;
    const sommeApres = lev.parDomaine.reduce((s, x) => s + (x.apres ?? 0), 0) / lev.parDomaine.length;
    expect(Math.abs(Math.round(sommeAvant * 1e6) / 1e6 - lev.collisionMoyenneAvant)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(Math.round(sommeApres * 1e6) / 1e6 - lev.collisionMoyenneApres)).toBeLessThanOrEqual(1e-6);
    const reduction = Math.round((1 - sommeApres / Math.max(1e-12, sommeAvant)) * 1000) / 10;
    expect(Math.abs(reduction - lev.reductionPct)).toBeLessThanOrEqual(0.1);
    // Chaque domaine voit sa collision BAISSER (le levier est global).
    expect(lev.parDomaine).toHaveLength(19);
    for (const x of lev.parDomaine) {
      expect(x.apres).toBeLessThan(x.avant);
    }
    // Le critère publié est cohérent (anti-maquillage).
    expect(a.bilan.criteres.levier_collision.atteint).toBe(true);
    expect(a.bilan.criteres.levier_collision.reductionPct).toBe(lev.reductionPct);
  });

  it("BIJECTION it.65 FIGÉE bit à bit : les deux ancres historiques sont intactes", () => {
    expect(texteGenere("recherche-web", 0)).toBe(ANCRE_IT65_RECHERCHE_WEB_0);
    expect(texteGenere("agriculture-environnement", 123456)).toBe(ANCRE_IT65_AGRICULTURE_123456);
  });

  it("nouvelle bijection SÛRE : unicité, ancrage CHARTE (label + taches/motsCles/outils), espace ≥ 10⁶/domaine (les 19)", () => {
    // Unicité : 19 domaines × 110 indices (famille différenciée, offsets
    // de campagne inclus) — zéro doublon, déterminisme bit à bit.
    const vus = new Set<string>();
    for (const id of IDS_VOCATION) {
      for (const i of [0, 1, 50, 99, 100, 123_456, 999_999, 70_000_000, 79_999_999, 80_000_000, 119_999_999]) {
        const t = texteDomaine(id, i);
        expect(vus.has(t), `doublon détecté pour ${id}#${i}`).toBe(false);
        vus.add(t);
        expect(texteDomaine(id, i)).toBe(t);
      }
    }
    // Ancrage charte : chaque texte porte le label ET au moins un token
    // de (taches ∪ motsCles ∪ outils) — zéro invention, zéro fait externe.
    for (const id of IDS_VOCATION) {
      const l = lexiqueDuDomaine(id);
      for (const i of [0, 7_654_321, 70_000_000, 119_999_999]) {
        const t = texteDomaine(id, i);
        expect(t).toContain(l.label);
        const ancre =
          l.taches.some((x) => t.includes(x)) ||
          l.motsCles.some((x) => t.includes(x)) ||
          l.outils.some((x) => t.includes(x));
        expect(ancre, `texte sans ancre charte : ${id}#${i} → ${t}`).toBe(true);
      }
      // La paire Q/R porte le même ancrage (motif + réponse).
      const p = paireDomaine(id, 70_000_000);
      expect(p.theme).toBe(l.label);
      expect(p.reponse).toContain(l.label);
    }
    // Espace combinatoire ≫ 1 000 000 par domaine (demande « 1 million de
    // données par domaine » — l'espace doit le porter sans collision).
    for (const d of DOMAINES_VOCATION) {
      expect(espaceCombinatoireDomaine({ id: d.id, label: d.label, taches: d.taches, motsCles: d.motsCles, outils: d.outils })).toBeGreaterThanOrEqual(1_000_000);
    }
    // La rotation couvre les 19 domaines sans être dégénérée.
    const rots = new Set(IDS_VOCATION.map((id) => rotationGabarit(indiceCharte(id))));
    expect(rots.size).toBeGreaterThanOrEqual(8);
  });

  it("C3 = comptage RÉEL = 13/19 re-dérivable des traces 6 décimales, les 6 échecs NOMMÉS, 19/19 PAS déclaré atteint", () => {
    const a = charger();
    const parDomaine = a.parDomaine;
    expect(parDomaine).toHaveLength(19);
    for (const d of parDomaine) {
      const c3Derive = d.traceApresVague1 / Math.max(1e-12, d.traceScratchV1);
      expect(Math.abs(c3Derive - d.c3)).toBeLessThanOrEqual(2e-6);
      expect(d.c3Atteint).toBe(d.c3 > 1);
    }
    const c3Compte = parDomaine.filter((d) => d.c3 > 1).length;
    expect(a.bilan.criteres.c3_gabarits_diff.valeur).toBe(c3Compte);
    expect(c3Compte).toBe(13);
    const echecs = parDomaine.filter((d) => !d.c3Atteint).map((d) => d.id).sort();
    expect(echecs).toEqual([...ECHECS_C3_IT72].sort());
    // Le niveau requis 19/19 n'est PAS déclaré atteint (anti-maquillage).
    expect(a.bilan.criteres.c3_gabarits_diff.atteint).toBe(false);
    // La REDISTRIBUTION est documentée : les échecs it.71 (recherche-web,
    // ingenierie-industrie, agriculture-environnement, transport-immobilier,
    // ia-specialisee-emergente) ne coïncident PAS avec les échecs it.72.
    const echecsIt71 = ["recherche-web", "ingenierie-industrie", "agriculture-environnement", "transport-immobilier", "ia-specialisee-emergente"];
    const gueris = echecsIt71.filter((x) => !echecs.includes(x));
    const bascules = echecs.filter((x) => !echecsIt71.includes(x));
    expect(gueris.length).toBeGreaterThanOrEqual(2);
    expect(bascules.length).toBeGreaterThanOrEqual(2);
  });

  it("C3b = 10/19 et SURVIE = 9/19, comptages réels re-dérivables des traces, sans-gain visibles sous l'unité", () => {
    const a = charger();
    const parDomaine = a.parDomaine;
    for (const d of parDomaine) {
      const c3bDerive = d.traceApresVague2 / Math.max(1e-12, d.traceAvantVague2);
      expect(Math.abs(c3bDerive - d.c3b)).toBeLessThanOrEqual(2e-6);
      expect(d.c3bAtteint).toBe(d.c3b > 1);
      const survieDerive = d.traceApresVague2SurVague1 / Math.max(1e-12, d.traceApresVague1);
      expect(Math.abs(survieDerive - d.survie)).toBeLessThanOrEqual(2e-6);
      expect(d.survieAtteint).toBe(d.survie > 1);
    }
    const c3bCompte = parDomaine.filter((d) => d.c3b > 1).length;
    const survieCompte = parDomaine.filter((d) => d.survie > 1).length;
    expect(a.bilan.criteres.c3b_boucle_continue.valeur).toBe(c3bCompte);
    expect(c3bCompte).toBe(10);
    expect(a.bilan.criteres.survie_memoire.valeur).toBe(survieCompte);
    expect(survieCompte).toBe(9);
    expect(a.bilan.criteres.c3b_boucle_continue.atteint).toBe(false);
    expect(a.bilan.criteres.survie_memoire.atteint).toBe(false);
    // Les sans-gain C3b restent SOUS l'unité (jamais arrondis à 1) —
    // publiés tels quels (zéro gonflage).
    const sansGain = a.parDomaine.filter((d) => !d.c3bAtteint);
    expect(sansGain).toHaveLength(9);
    for (const d of sansGain) {
      expect(d.c3b).toBeGreaterThanOrEqual(0.999);
      expect(d.c3b).toBeLessThan(1);
    }
  });

  it("stabilité : C4 < 3 sur les DEUX vagues, aucun delta n'explose, NORMALISATIONS = 0, poidsMax ≤ 1, saturation = équilibre matière-indépendant (2 358 856)", () => {
    const a = charger();
    const mesures = a.entrainement.mesuresStabilite;
    const blocsV1 = mesures.filter((m) => m.vague === 1);
    const blocsV2 = mesures.filter((m) => m.vague === 2);
    expect(blocsV1.length).toBeGreaterThanOrEqual(2);
    expect(blocsV2.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < mesures.length; i++) {
      const delta = mesures[i]!.transmissionsCumul - mesures[i - 1]!.transmissionsCumul;
      expect(delta).toBeGreaterThan(0);
      const deltaNorm = mesures[i]!.normalisationsCumul - mesures[i - 1]!.normalisationsCumul;
      expect(deltaNorm).toBeGreaterThanOrEqual(0);
    }
    const ratioV1 = blocsV1[blocsV1.length - 1]!.transmissions / blocsV1[0]!.transmissions;
    const ratioV2 = blocsV2[blocsV2.length - 1]!.transmissions / blocsV2[0]!.transmissions;
    expect(Math.round(ratioV1 * 1000) / 1000).toBe(a.bilan.criteres.c4_stabilite.ratioTransmissionsVague1);
    expect(Math.round(ratioV2 * 1000) / 1000).toBe(a.bilan.criteres.c4_stabilite.ratioTransmissionsVague2);
    expect(ratioV1).toBeLessThan(3);
    expect(ratioV2).toBeLessThan(3);
    expect(a.bilan.criteres.c4_stabilite.normalisationsTotales).toBe(0);
    expect(a.entrainement.metabolisme.normalisations).toBe(0);
    expect(a.bilan.criteres.c4_stabilite.poidsMaxFin).toBeLessThanOrEqual(1.0);
    // FAIT MESURÉ CLÉ it.72 : l'équilibre de saturation est IDENTIQUE à
    // it.71 (2 358 856 arêtes) bien que la matière change entièrement —
    // l'équilibre est structurel, pas matière-dépendant.
    expect(a.bilan.criteres.c4_stabilite.aretesSatureesFin).toBe(2_358_856);
    const met = a.entrainement.metabolisme;
    expect(met.transmissions).toBeGreaterThan(0);
    expect(met.ms).toBeGreaterThan(0);
    expect(a.bilan.criteres.c4_stabilite.atteint).toBe(true);
  });

  it("traces PAR POINT : 38 points par vague, cohérents avec les moyennes (tolérance de ré-arrondi)", () => {
    const a = charger();
    const p1 = a.pointsDeSonde.vague1;
    const p2 = a.pointsDeSonde.vague2;
    expect(p1).toHaveLength(38);
    expect(p2).toHaveLength(38);
    for (const id of IDS_VOCATION) {
      const dp1 = p1.filter((x) => x.domaine === id);
      const dp2 = p2.filter((x) => x.domaine === id);
      expect(dp1.map((x) => x.indice).sort()).toEqual(["debut", "fin"]);
      expect(dp2.map((x) => x.indice).sort()).toEqual(["debut", "fin"]);
    }
    for (const d of a.parDomaine) {
      const dp1 = p1.filter((x) => x.domaine === d.id);
      const ratiosScr = dp1.map((x) => x.ratioScratch);
      const ratiosAp1 = dp1.map((x) => x.ratioApresVague1);
      expect(Math.max(...ratiosScr)).toBeGreaterThanOrEqual(d.traceScratchV1 * 0.99);
      expect(Math.min(...ratiosScr)).toBeLessThanOrEqual(d.traceScratchV1 * 1.01);
      expect(Math.max(...ratiosAp1)).toBeGreaterThanOrEqual(d.traceApresVague1 * 0.99);
      expect(Math.min(...ratiosAp1)).toBeLessThanOrEqual(d.traceApresVague1 * 1.01);
    }
    for (const pt of p2) {
      expect(IDS_VOCATION).toContain(pt.domaine);
      expect(["debut", "fin"]).toContain(pt.indice);
    }
    for (const pt of p1) {
      expect(IDS_VOCATION).toContain(pt.domaine);
      expect(["debut", "fin"]).toContain(pt.indice);
    }
  });

  it("l'ordre des 19 domaines = charte du propriétaire, bandes vocabulaires valides [0,8)", () => {
    const a = charger();
    expect(a.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of a.parDomaine) {
      expect(d.bandeVocab).toBeGreaterThanOrEqual(0);
      expect(d.bandeVocab).toBeLessThanOrEqual(7);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.collisionAvant).not.toBeNull();
      expect(d.collisionApres).not.toBeNull();
    }
  });

  it("honnêteté : ≥ 5 limites présentes (non-comparabilité, bijection it.65 figée, mots de fonction, pont vocation), C1/C2 atteints, échecs visibles", () => {
    const a = charger();
    const limites = a.bilan.limitesHonnetes;
    expect(limites.length).toBeGreaterThanOrEqual(5);
    const toutes = limites.join(" ");
    expect(toutes).toContain("PAS comparable bit à bit");
    expect(toutes).toContain("expérience contrôlée");
    expect(toutes).toContain("plafond-leve-it71.json");
    expect(toutes).toContain("FIGÉE bit à bit");
    expect(toutes).toContain("MOTS DE FONCTION");
    expect(toutes).toContain("PONT VOCATION");
    expect(toutes).toContain("mesure de MATIÈRE");
    // C1/C2 = 19/19 sur les DEUX vagues (la matière a bien été consommée).
    expect(a.bilan.criteres.c1_donnees_fraises.atteint).toBe(true);
    expect(a.bilan.criteres.c2_renforts_positifs.atteint).toBe(true);
    // Les échecs restent VISIBLES : C3 6 échecs nommés, C3b 9, survie 10.
    expect(a.parDomaine.filter((d) => !d.c3Atteint)).toHaveLength(6);
    expect(a.parDomaine.filter((d) => !d.c3bAtteint)).toHaveLength(9);
    expect(a.parDomaine.filter((d) => !d.survieAtteint)).toHaveLength(10);
  });
});
