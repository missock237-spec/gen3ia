/**
 * VALIDATION RAPIDE it.63-bis — l'onde balaye la bande-porteuse : 3
 * domaines (bandes différentes) × 20 000 échantillons entrelacés, sondes
 * TRACE cycle-1 + GÉNÉRALISATION vs témoin vierge. Décide du lancement de
 * la campagne complète.
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

const DOMS = ["recherche-web", "cybersecurite", "medecine-sante", "art-creation-multimedia"];
const NB = 20_000;
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

function texteInconnu(domaine: string): string {
  return `sonde de généralisation ${domaine} : le porteur fréquentiel traverse la bande corticale, l'écho columnnaire mesure la plasticité consolidée — jamais entraîné, structure distincte.`;
}

function ratioC1(cortex: CortexColumnnaire, texte: string, horloge: number, bande: number): number {
  const paquets = analyserOndeTexte(texte, horloge);
  const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes, bande, cortex.config.bandes);
  cortex.pas(injections, horloge + 1);
  const act = cortex.activationBandes();
  let somme = 0;
  for (let b = 0; b < act.length; b++) if (b !== bande) somme += act[b] ?? 0;
  return (act[bande] ?? 0) / Math.max(1e-12, somme / (act.length - 1));
}

function main(): void {
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const champ = new ChampCorticalGen3();
  let h = 0;
  const horloges = new Map<string, number[]>();
  for (const d of DOMS) horloges.set(d, []);
  const t0 = Date.now();
  for (let e = 0; e < NB / LOT; e++) {
    for (const d of DOMS) {
      const lot: ExempleOnde[] = [];
      for (let i = 0; i < LOT; i++) {
        const idx = e * LOT + i;
        lot.push({ texte: phrase(d, idx), domaine: d });
        if (idx === 5 || idx === NB - 3) horloges.get(d)!.push(h + 3 * i);
      }
      entrainerDomainesParOndes(cortex, champ, lot, { maxParDomaine: LOT, horlogeInitiale: h });
      h += 3 * LOT;
    }
  }
  console.log(`Entraînement : ${((Date.now() - t0) / 1000).toFixed(0)} s — horloge ${h.toLocaleString("fr-FR")}`);
  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  for (const d of DOMS) {
    const bande = bandeDuDomaine(d);
    const trace = horloges.get(d)!.map((hr) => ratioC1(cortex, phrase(d, 5), hr, bande));
    const traceTemoin = horloges.get(d)!.map((hr) => ratioC1(temoin, phrase(d, 5), hr, bande));
    const gt = trace.reduce((a, x) => a + x, 0) / trace.length;
    const gtt = traceTemoin.reduce((a, x) => a + x, 0) / traceTemoin.length;
    const gen = ratioC1(cortex, texteInconnu(d), 0, bande);
    const genT = ratioC1(temoin, texteInconnu(d), 0, bande);
    console.log(
      `${d.padEnd(26)} b${bande} (${porteurBande(bande).toFixed(2)}) trace ${gt.toFixed(2)} vs ${gtt.toFixed(2)} → ×${(gt / Math.max(1e-9, gtt)).toFixed(2)} | gén ${gen.toFixed(2)} vs ${genT.toFixed(2)} → ×${(gen / Math.max(1e-9, genT)).toFixed(2)}`,
    );
  }
}

main();
