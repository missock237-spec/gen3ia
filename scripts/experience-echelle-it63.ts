/**
 * EXPÉRIENCE D'ÉCHELLE it.63 — 2 domaines × 1 000 000 échantillons
 * (entrelacé, 500 époques × 2000), sondes TRACE (rejeu à l'horloge exacte)
 * + GÉNÉRALISATION (texte jamais vu du même domaine) + témoin vierge.
 * Décide si la campagne 19M conserve une discrimination mesurable.
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
  type ExempleOnde,
} from "../lib/neural/training/entrainement-ondes";

const DOM_A = "recherche-web";
const DOM_B = "cybersecurite";
const NB = 1_000_000;
const LOT = 2000;

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

/** Texte JAMAIS vu (vocabulaire du domaine, structure différente). */
function texteInconnu(domaine: string): string {
  return `sonde de généralisation ${domaine} : la résonance du porteur fréquentiel traverse la bande corticale, l'écho columnnaire mesure la plasticité consolidée du domaine — jamais entraîné, structure distincte.`;
}

function ratioCycle(cortex: CortexColumnnaire, texte: string, horloge: number, bande: number, cycles: number): number {
  const paquets = analyserOndeTexte(texte, horloge);
  const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
  let r = 0;
  for (let c = 0; c < cycles; c++) {
    cortex.pas(c === 0 ? injections : null, horloge + c + 1);
    if (c === cycles - 1) {
      const act = cortex.activationBandes();
      let somme = 0, n = 0;
      for (let b = 0; b < act.length; b++) if (b !== bande) { somme += act[b] ?? 0; n++; }
      r = (act[bande] ?? 0) / Math.max(1e-12, somme / n);
    }
  }
  return r;
}

function main() {
  const bandeA = bandeDuDomaine(DOM_A);
  const bandeB = bandeDuDomaine(DOM_B);
  console.log(`2 domaines × ${NB.toLocaleString("fr-FR")} — bande A=${bandeA}, B=${bandeB}`);
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const champ = new ChampCorticalGen3();
  const t0 = Date.now();
  let h = 0;
  const echantillonHorlogeA: Array<[string, number]> = [];
  const echantillonHorlogeB: Array<[string, number]> = [];
  for (let e = 0; e < NB / LOT; e++) {
    const exA: ExempleOnde[] = [];
    for (let i = 0; i < LOT; i++) {
      const idx = e * LOT + i;
      exA.push({ texte: phrase(DOM_A, idx), domaine: DOM_A });
      if (idx === 5 || idx === 500_005 || idx === NB - 3) echantillonHorlogeA.push([phrase(DOM_A, idx), h + 3 * i]);
    }
    entrainerDomainesParOndes(cortex, champ, exA, { maxParDomaine: LOT, horlogeInitiale: h });
    h += 3 * LOT;
    const exB: ExempleOnde[] = [];
    for (let i = 0; i < LOT; i++) {
      const idx = e * LOT + i;
      exB.push({ texte: phrase(DOM_B, idx), domaine: DOM_B });
      if (idx === 5 || idx === 500_005 || idx === NB - 3) echantillonHorlogeB.push([phrase(DOM_B, idx), h + 3 * i]);
    }
    entrainerDomainesParOndes(cortex, champ, exB, { maxParDomaine: LOT, horlogeInitiale: h });
    h += 3 * LOT;
    if ((e + 1) % 100 === 0) console.log(`  époque ${e + 1}/${NB / LOT} — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  console.log(`Entraînement : ${((Date.now() - t0) / 1000).toFixed(0)} s — horloge finale ${h.toLocaleString("fr-FR")}`);

  // Témoin vierge
  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  console.log(`TÉMOIN    trace A c1 : ${ratioCycle(temoin, phrase(DOM_A, 5), 15, bandeA, 1).toFixed(2)} | B : ${ratioCycle(temoin, phrase(DOM_B, 5), 15, bandeB, 1).toFixed(2)}`);
  console.log(`TÉMOIN    gén.  A c1 : ${ratioCycle(temoin, texteInconnu(DOM_A), 0, bandeA, 1).toFixed(2)} | B : ${ratioCycle(temoin, texteInconnu(DOM_B), 0, bandeB, 1).toFixed(2)}`);

  // Traces entraînées (3 échantillons à leur horloge exacte)
  for (const [dom, sondes, bande] of [[DOM_A, echantillonHorlogeA, bandeA], [DOM_B, echantillonHorlogeB, bandeB]] as const) {
    const ratios = sondes.map(([txt, hr]) => ratioCycle(cortex, txt, hr, bande, 1).toFixed(2));
    const gen = ratioCycle(cortex, texteInconnu(dom), 0, bande, 1);
    console.log(`ENTRAÎNÉ ${dom} trace c1 : ${ratios.join(" / ")} | généralisation : ${gen.toFixed(2)}`);
  }
}

main();
