/**
 * EXPÉRIENCE DISCRIMINANTE it.63 — la question : à grande échelle (1M+
 * échantillons/domaine), la trace par domaine survit-elle ? Toutes les
 * colonnes sont partagées entre domaines (les ondes balayent le substrat)
 * → risque d'égalisation des bandes-porteuses.
 *
 * Protocole : 2 domaines × 20 000 échantillons, deux ordonnancements
 * (séquentiel / entrelacé), sondes TRACE (rejeu à l'horloge exacte,
 * activation bande-porteuse vs moyenne des autres) à chaque cycle,
 * comparés à un cortex témoin vierge.
 */
import {
  CortexColumnnaire,
  CORTEX_CONFIG_DEFAUTS,
} from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import {
  analyserOndeTexte,
  bandeDuDomaine,
  colonnesDepuisOndes,
  entrainerDomainesParOndes,
  porteurBande,
  type ExempleOnde,
} from "../lib/neural/training/entrainement-ondes";

const DOM_A = "recherche-web";
const DOM_B = "cybersecurite";

function phrase(domaine: string, i: number): string {
  const sujets = ["gen3", "l'opérateur", "le système", "l'agent autonome", "le module"];
  const verbes = ["analyse", "exécute", "consolide", "vérifie", "orchestre", "évalue"];
  const complements = [
    "les données du domaine avec précision",
    "la tâche demandée selon la charte",
    "le flux d'ondes corticales en résonance",
    "le rapport honnête de la session",
    "les outils réels servis par l'API",
  ];
  return `${domaine} ${i} : ${sujets[i % 5]} ${verbes[(i >> 3) % 6]} ${complements[(i >> 6) % 5]}, mesure ${i * 7} du protocole.`;
}

function echantillons(domaine: string, n: number, decalage: number): ExempleOnde[] {
  const out: ExempleOnde[] = [];
  for (let i = 0; i < n; i++) out.push({ texte: phrase(domaine, decalage + i), domaine });
  return out;
}

/** Sonde TRACE : rejeu d'un échantillon entraîné à son horloge exacte,
 *  activation de la bande-porteuse vs moyenne des autres, APRÈS CHAQUE cycle. */
function sonde(cortex: CortexColumnnaire, texte: string, horlogeEchantillon: number, bande: number) {
  const paquets = analyserOndeTexte(texte, horlogeEchantillon);
  const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
  const lectures: number[] = [];
  for (let c = 0; c < 3; c++) {
    cortex.pas(c === 0 ? injections : null, horlogeEchantillon + c + 1);
    const act = cortex.activationBandes();
    const autres: number[] = [];
    for (let b = 0; b < act.length; b++) if (b !== bande) autres.push(act[b] ?? 0);
    const moyenneAutres = autres.reduce((a, x) => a + x, 0) / autres.length;
    lectures.push((act[bande] ?? 0) / Math.max(1e-12, moyenneAutres));
  }
  return lectures;
}

function main() {
  const NB = 20_000;
  const horloges: Record<string, number[]> = { [DOM_A]: [], [DOM_B]: [] };
  for (const [dom, n] of [[DOM_A, NB], [DOM_B, NB]] as const) {
    for (let i = 0; i < n; i++) horloges[dom].push(3 * i);
  }
  const bandeA = bandeDuDomaine(DOM_A);
  const bandeB = bandeDuDomaine(DOM_B);
  console.log(`bande(${DOM_A}) = ${bandeA} — bande(${DOM_B}) = ${bandeB} (porteurs ${porteurBande(bandeA).toFixed(2)} / ${porteurBande(bandeB).toFixed(2)})`);

  // --- Témoin vierge -------------------------------------------------------
  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const rA0 = sonde(temoin, phrase(DOM_A, 0), horloges[DOM_A][0], bandeA);
  const rB0 = sonde(temoin, phrase(DOM_B, 0), horloges[DOM_B][0], bandeB);
  console.log(`TÉMOIN   ratio ${DOM_A} (cycles 1-3) : ${rA0.map((x) => x.toFixed(2)).join(" / ")}`);
  console.log(`TÉMOIN   ratio ${DOM_B} (cycles 1-3) : ${rB0.map((x) => x.toFixed(2)).join(" / ")}`);

  // --- Variante séquentielle : A entièrement, puis B -----------------------
  {
    const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
    const champ = new ChampCorticalGen3();
    let h = 0;
    const exA = echantillons(DOM_A, NB, 0);
    const exB = echantillons(DOM_B, NB, 1_000_000);
    const _rA = entrainerDomainesParOndes(cortex, champ, exA, { maxParDomaine: 2000, horlogeInitiale: h });
    h += 3 * NB;
    entrainerDomainesParOndes(cortex, champ, exB, { maxParDomaine: 2000, horlogeInitiale: h });
    const sA = sonde(cortex, phrase(DOM_A, 5), 3 * 5, bandeA);
    const sB = sonde(cortex, phrase(DOM_B, 1_000_005), 3 * NB + 3 * 5, bandeB);
    console.log(`SÉQ.     ratio ${DOM_A} : ${sA.map((x) => x.toFixed(2)).join(" / ")}   |  ${DOM_B} : ${sB.map((x) => x.toFixed(2)).join(" / ")}`);
  }

  // --- Variante entrelacée : 10 époques × 2000+2000 ------------------------
  {
    const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
    const champ = new ChampCorticalGen3();
    let h = 0;
    const lot = 2000;
    for (let e = 0; e < 10; e++) {
      const exA = echantillons(DOM_A, lot, e * lot);
      const _rA = entrainerDomainesParOndes(cortex, champ, exA, { maxParDomaine: lot, horlogeInitiale: h });
      h += 3 * lot;
      const exB = echantillons(DOM_B, lot, 1_000_000 + e * lot);
      entrainerDomainesParOndes(cortex, champ, exB, { maxParDomaine: lot, horlogeInitiale: h });
      h += 3 * lot;
    }
    const sA = sonde(cortex, phrase(DOM_A, 5), 3 * 5, bandeA);
    const sB = sonde(cortex, phrase(DOM_B, 1_000_005), 3 * (10 * lot) + 3 * 5, bandeB);
    console.log(`ENTREL.  ratio ${DOM_A} : ${sA.map((x) => x.toFixed(2)).join(" / ")}   |  ${DOM_B} : ${sB.map((x) => x.toFixed(2)).join(" / ")}`);
  }
}

main();
