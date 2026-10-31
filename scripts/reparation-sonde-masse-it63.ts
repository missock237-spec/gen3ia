/**
 * RÉPARATION DE LA SONDE — campagne massive it.63 (époques).
 *
 * CONSTAT (revue de coordination it.63) : le run initial de
 * scripts/pretrain-masse-1m-it63.ts a produit un artefact dont la sonde
 * « témoin » lit EXACTEMENT 0 (ratiosTemoin = [0,0,0]) — d'où des gains
 * astronomiques (×4,1e9) et un « 19/19 » VIDE (division par un témoin nul).
 * Une expérience de contrôle (témoin vierge, même protocole cycle-1) lit
 * des ratios sains (3,3–4,4) : le zéro est un bug de run, pas une propriété.
 *
 * RÉPARATION HONNÊTE : l'état cortical FINAL de la campagne existe
 * (assets/neural-pretrained/cortex-v2.bin — écrit à la fin du run réel).
 * Ce script :
 *  1. reconstruit EXACTEMENT les points de sonde du run (échantillonnage
 *     déterministe identique + horloges exactes du planning époques) ;
 *  2. recharge l'état cortical final et mesure les ratios entraînés ;
 *  3. mesure les ratios TÉMOIN sur un cortex vierge (même protocole) ;
 *  4. réécrit la sonde de l'artefact avec les valeurs recalculées + une
 *     note de traçabilité (rien d'autre n'est modifié).
 *
 * Aucune métrique inventée : tout est re-mesuré sur l'état réel.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire, CORTEX_CONFIG_DEFAUTS } from "../lib/neural/core/v2/cortex-columnnaire";
import { lireArtefactV2 } from "../lib/neural/core/v2/persistance-v2";
import { analyserOndeTexte, colonnesDepuisOndes, porteurBande, bandeDuDomaine } from "../lib/neural/training/entrainement-ondes";
import type { ExempleOnde } from "../lib/neural/training/entrainement-ondes";
import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";

/* ---- Réplique EXACTE du générateur du run (scripts/pretrain-masse-1m-it63.ts — fonctions non exportées) ---- */

const LOT = 2000;
const INDICES_TRACE = [5, 500_005, 1_001_995];

interface Vocabulaire {
  label: string;
  sujets: string[];
  verbes: string[];
  objets: string[];
  cadres: string[];
  termes: string[];
}

function vocabulaireDuDomaine(domaine: (typeof DOMAINES_VOCATION)[number]): Vocabulaire {
  const sujets = ["gen3", "l'opérateur", "l'agent autonome", "le module de domaine", "le cerveau columnnaire", "l'index cortical"];
  const verbes = ["analyse", "exécute", "consolide", "vérifie", "orchestre", "évalue", "structure", "mesure"];
  const objets = domaine.taches.slice(0, 12);
  const cadres = [
    "selon la charte de vocation",
    "avec le rapport honnête de la session",
    "en résonance avec la bande-porteuse du domaine",
    "avec les outils réels de la plateforme",
    "sans service d'IA distant",
    "sur le substrat columnnaire local",
  ];
  const termes = [...domaine.motsCles];
  return { label: domaine.label, sujets, verbes, objets, cadres, termes };
}

function echantillon(v: Vocabulaire, idDomaine: string, i: number): ExempleOnde {
  const sujet = v.sujets[i % v.sujets.length] ?? "gen3";
  const verbe = v.verbes[(i >> 3) % v.verbes.length] ?? "analyse";
  const objet = v.objets[(i >> 6) % v.objets.length] ?? "tâche";
  const cadre = v.cadres[(i >> 9) % v.cadres.length] ?? "selon la charte de vocation";
  const terme = v.termes.length > 0 ? v.termes[(i >> 12) % v.termes.length] : v.label;
  const texte = `${v.label} — échantillon ${i} : ${sujet} ${verbe} ${objet} (${cadre}) ; vocabulaire du domaine : ${terme}, porteur ${porteurBande(bandeDuDomaine(idDomaine)).toFixed(2)} rad/cycle.`;
  return { texte, domaine: idDomaine };
}

function texteInconnu(domaine: (typeof DOMAINES_VOCATION)[number], k: number): string {
  return `sonde de généralisation ${k} — ${domaine.label} : le porteur fréquentiel traverse la bande corticale, l'écho columnnaire mesure la plasticité consolidée de ce domaine jamais relu, structure distincte des échantillons d'entraînement.`;
}

/** Protocole de sonde du run (lecture cycle-1, balayage bande-contraint). */
function ratioPorteur(cortex: CortexColumnnaire, texte: string, horloge: number, bande: number): number {
  const paquets = analyserOndeTexte(texte, horloge);
  const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes, bande, cortex.config.bandes);
  cortex.pas(injections, horloge + 1);
  const act = cortex.activationBandes();
  let somme = 0;
  for (let b = 0; b < act.length; b++) if (b !== bande) somme += act[b] ?? 0;
  return (act[bande] ?? 0) / Math.max(1e-12, somme / (act.length - 1));
}

function moyenne(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
}

/* ---- Reconstruction des horloges exactes du planning époques ---- */

const RANGS = new Map<string, number>(IDS_VOCATION.map((id, i) => [id, i]));

/** horloge d'analyse de l'échantillon idx du domaine id : 3 cycles/échantillon,
 *  lot de 2000 par domaine, époques interclassées (ordre de la charte). */
function horlogeDe(id: string, idx: number): number {
  const e = Math.floor(idx / LOT);
  const i = idx % LOT;
  return 3 * (e * IDS_VOCATION.length * LOT + (RANGS.get(id) ?? 0) * LOT + i);
}

/* ---- Réparation ---- */

interface SondeDomaine {
  domaine: string;
  bande: number;
  trace: { ratios: number[]; ratiosTemoin: number[]; gain: number; assimile: boolean };
  generalisation: { ratio: number; ratioTemoin: number; gain: number };
}
interface ArtefactMasse {
  date: string;
  sonde: { assimiles: number; total: number; seuilAssimile: number; domaines: SondeDomaine[]; protocole: string };
  [k: string]: unknown;
}

const SEUIL_ASSIMILE = 1.25;

function main(): void {
  const cheminRapport = join(process.cwd(), "assets/neural-pretrained/preentrainement-masse-1m-it63.json");
  const cheminCortex = join(process.cwd(), "assets/neural-pretrained/cortex-v2.bin");
  const artefact = JSON.parse(readFileSync(cheminRapport, "utf8")) as ArtefactMasse;

  const etat = lireArtefactV2(cheminCortex);
  if (!etat) throw new Error("État cortical final introuvable (assets/neural-pretrained/cortex-v2.bin) — réparation impossible");
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  if (!cortex.importerPoids(etat.poids)) throw new Error("Import des poids impossible (incohérence structurelle)");

  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const vocabulaires = new Map(IDS_VOCATION.map((id) => [id, vocabulaireDuDomaine(DOMAINES_VOCATION.find((d) => d.id === id)!)]));

  let repairs = 0;
  for (const sd of artefact.sonde.domaines) {
    const id = sd.domaine;
    const bande = bandeDuDomaine(id);
    const v = vocabulaires.get(id)!;
    const points = INDICES_TRACE.map((idx) => {
      const ex = echantillon(v, id, idx);
      return [ex.texte, horlogeDe(id, idx)] as [string, number];
    });
    const ratios = points.map(([txt, hr]) => ratioPorteur(cortex, txt, hr, bande));
    const ratiosTemoin = points.map(([txt, hr]) => ratioPorteur(temoin, txt, hr, bande));
    const gain = moyenne(ratios) / Math.max(1e-9, moyenne(ratiosTemoin));
    const gens = [0, 1].map((k) => ratioPorteur(cortex, texteInconnu(DOMAINES_VOCATION.find((d) => d.id === id)!, k), 0, bande));
    const gensTemoin = [0, 1].map((k) => ratioPorteur(temoin, texteInconnu(DOMAINES_VOCATION.find((d) => d.id === id)!, k), 0, bande));
    const gainGen = moyenne(gens) / Math.max(1e-9, moyenne(gensTemoin));
    console.log(
      `${id.padEnd(30)} b${bande} trace ${moyenne(ratios).toFixed(3)} / témoin ${moyenne(ratiosTemoin).toFixed(3)} = ×${gain.toFixed(3)} ${gain >= SEUIL_ASSIMILE ? "ASSIMILÉ" : "faible"} | gén ×${gainGen.toFixed(3)}`,
    );
    sd.trace = { ratios, ratiosTemoin, gain, assimile: gain >= SEUIL_ASSIMILE };
    sd.generalisation = { ratio: moyenne(gens), ratioTemoin: moyenne(gensTemoin), gain: gainGen };
    repairs += 1;
  }
  artefact.sonde.assimiles = artefact.sonde.domaines.filter((d) => d.trace.assimile).length;
  artefact.sonde.protocole +=
    " — RÉPARATION it.63 : le run initial lisait un témoin NUL (ratiosTemoin = 0 → gains vides ×10⁹) ; la sonde a été RE-MESURÉE à l'état cortical final (cortex-v2.bin, inchangé) avec un témoin vierge et le protocole cycle-1 identique — points de sonde reconstruits à l'identique (échantillonnage déterministe + horloges exactes du planning époques).";
  writeFileSync(cheminRapport, JSON.stringify(artefact, null, 2) + "\n");
  console.log(`\nSonde réparée : ${repairs}/19 domaines re-mesurés — assimilés (gain ≥ ${SEUIL_ASSIMILE}) : ${artefact.sonde.assimiles}/19.`);
  console.log("Artefact mis à jour : assets/neural-pretrained/preentrainement-masse-1m-it63.json");
}

main();
