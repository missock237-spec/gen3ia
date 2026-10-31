/**
 * SONDE CORRIGÉE it.63 — réécriture honnête de la section « sonde » du
 * rapport de campagne massive.
 *
 * CORRECTION (honnêteté) : la sonde embarquée de la campagne lisait le
 * ratio au cycle 3 — où le cortex TÉMOIN vierge n'a aucune énergie
 * (ratio témoin ≈ 0) — ce qui produit des « gains » astronomiques et
 * NON INTERPRÉTABLES (division par ~0). La sonde corrigée lit le ratio
 * bande-porteuse/autres au CYCLE 1 (premier pas d'injection — le même
 * protocole que scripts/experience-echelle-it63.ts : trace ×3,
 * généralisation ×2.4 sur 2 domaines × 1 M). Les ratios des cycles 2-3
 * restent rapportés pour transparence, sans gain dérivé.
 *
 * Le cortex entraîné est RECHARGÉ depuis le checkpoint final
 * (var/neural/cortex-v2-masse-it63.bin) — AUCUN ré-entraînement : les
 * échantillons, le métabolisme et l'horloge du rapport de campagne sont
 * conservés tels quels ; seule la section sonde est recalculée.
 *
 * Usage : npx tsx scripts/sonde-masse-it63.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire, CORTEX_CONFIG_DEFAUTS } from "../lib/neural/core/v2/cortex-columnnaire";
import { lireArtefactV2 } from "../lib/neural/core/v2/persistance-v2";
import {
  analyserOndeTexte,
  bandeDuDomaine,
  colonnesDepuisOndes,
  porteurBande,
} from "../lib/neural/training/entrainement-ondes";
import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";

const CHEMIN_CHECKPOINT = "var/neural/cortex-v2-masse-it63.bin";
const CHEMIN_RAPPORT = "assets/neural-pretrained/preentrainement-masse-1m-it63.json";
const SEUIL_ASSIMILE = 1.25;
const LOT = 2000;

// ------- Vocabulaire (identique bit-à-bit à la campagne) -------------------
const ALIAS_CORPUS: Record<string, string[]> = {
  "recherche-web": ["recherche_web"],
  "controle-donnees": ["analyse_donnees", "test"],
  "redaction-texte": ["redaction_documents"],
  "analyse-documents": ["redaction_documents", "multimodal"],
  "generation-code": ["developpement_web"],
  "analyse-donnees": ["analyse_donnees"],
  cybersecurite: ["cybersecurite", "hacker"],
  "medecine-sante": ["sante_medical"],
  "commerce-economie": ["vente", "conseiller_commercial"],
  "langue-communication": ["redaction_documents", "sciences_humaines"],
  "ingenierie-industrie": ["construction_machines"],
  "art-creation-multimedia": ["generation_images", "video", "son", "clips_musicaux", "multimodal"],
  "education-recherche": ["recherche_scientifique"],
  "sciences-humaines-sociales": ["sciences_humaines"],
  "domaines-specialises-emergents-ia": ["multimodal", "test"],
};

function motsClesCorpus(alias: string[] | undefined): string[] {
  if (!alias || alias.length === 0) return [];
  try {
    const manifeste = JSON.parse(
      readFileSync(join(process.cwd(), "training/gen3-domain-datasets/manifest.json"), "utf8"),
    ) as { domains: Array<{ id: string; mots_cles: string[]; nom_fr: string }> };
    const termes: string[] = [];
    for (const id of alias) {
      const d = manifeste.domains.find((x) => x.id === id);
      if (d) termes.push(...d.mots_cles, d.nom_fr);
    }
    return termes;
  } catch {
    return [];
  }
}

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
  const termes = [...domaine.motsCles, ...motsClesCorpus(ALIAS_CORPUS[domaine.id])];
  return { label: domaine.label, sujets, verbes, objets, cadres, termes };
}

function echantillon(v: Vocabulaire, idDomaine: string, i: number): string {
  const sujet = v.sujets[i % v.sujets.length];
  const verbe = v.verbes[(i >> 3) % v.verbes.length];
  const objet = v.objets[(i >> 6) % v.objets.length];
  const cadre = v.cadres[(i >> 9) % v.cadres.length];
  const terme = v.termes.length > 0 ? v.termes[(i >> 12) % v.termes.length] : v.label;
  return `${v.label} — échantillon ${i} : ${sujet} ${verbe} ${objet} (${cadre}) ; vocabulaire du domaine : ${terme}, porteur ${porteurBande(bandeDuDomaine(idDomaine)).toFixed(2)} rad/cycle.`;
}

function texteInconnu(domaine: (typeof DOMAINES_VOCATION)[number], k: number): string {
  return `sonde de généralisation ${k} — ${domaine.label} : le porteur fréquentiel traverse la bande corticale, l'écho columnnaire mesure la plasticité consolidée de ce domaine jamais relu, structure distincte des échantillons d'entraînement.`;
}

/** Horloge exacte d'un échantillon de la campagne (formule de l'entrelacement). */
function horlogeEchantillon(idDomaine: string, idx: number): number {
  const pos = IDS_VOCATION.indexOf(idDomaine);
  const e = Math.floor(idx / LOT);
  const i = idx - e * LOT;
  return 3 * LOT * (19 * e + pos) + 3 * i;
}

/** Ratios porteur/autres lus après CHAQUE cycle (1, 2, 3). */
function ratiosParCycle(cortex: CortexColumnnaire, texte: string, horloge: number, bande: number): number[] {
  const paquets = analyserOndeTexte(texte, horloge);
  const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes, bande, cortex.config.bandes);
  const ratios: number[] = [];
  for (let c = 0; c < 3; c++) {
    cortex.pas(c === 0 ? injections : null, horloge + c + 1);
    const act = cortex.activationBandes();
    let somme = 0;
    for (let b = 0; b < act.length; b++) if (b !== bande) somme += act[b] ?? 0;
    ratios.push((act[bande] ?? 0) / Math.max(1e-12, somme / (act.length - 1)));
  }
  return ratios;
}

function moyenne(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
}

function main(): void {
  if (!existsSync(CHEMIN_CHECKPOINT)) {
    console.error("Checkpoint introuvable — lancez d'abord la campagne.");
    process.exit(1);
  }
  const etat = lireArtefactV2(CHEMIN_CHECKPOINT);
  if (!etat || etat.colonnes !== CORTEX_CONFIG_DEFAUTS.colonnes) {
    console.error("Checkpoint incompatible.");
    process.exit(1);
  }
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  cortex.importerPoids(etat.poids);
  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  console.log("Sonde corrigée (lecture CYCLE 1) — cortex recharge depuis le checkpoint, témoin vierge.");

  const domainesRapport: Array<Record<string, unknown>> = [];
  let assimiles = 0;
  for (const domaine of DOMAINES_VOCATION) {
    const id = domaine.id;
    const bande = bandeDuDomaine(id);
    const v = vocabulaireDuDomaine(domaine);
    const indices = [5, 500_005, 1_001_995];
    const ratios: number[][] = [];
    const ratiosTemoin: number[][] = [];
    for (const idx of indices) {
      const texte = echantillon(v, id, idx);
      const horloge = horlogeEchantillon(id, idx);
      ratios.push(ratiosParCycle(cortex, texte, horloge, bande));
      ratiosTemoin.push(ratiosParCycle(temoin, texte, horloge, bande));
    }
    const cycles1 = ratios.map((r) => r[0]);
    const cycles1Temoin = ratiosTemoin.map((r) => r[0]);
    const gain = moyenne(cycles1) / Math.max(1e-9, moyenne(cycles1Temoin));
    const gens = [0, 1].map((k) => ratiosParCycle(cortex, texteInconnu(domaine, k), 0, bande)[0]);
    const gensTemoin = [0, 1].map((k) => ratiosParCycle(temoin, texteInconnu(domaine, k), 0, bande)[0]);
    const gainGen = moyenne(gens) / Math.max(1e-9, moyenne(gensTemoin));
    const assimile = gain >= SEUIL_ASSIMILE;
    if (assimile) assimiles += 1;
    domainesRapport.push({
      domaine: id,
      bande,
      porteurFrequence: porteurBande(bande),
      trace: {
        ratios: cycles1.map((x) => Number(x.toFixed(4))),
        cycles23: ratios.map((r) => [Number(r[1].toFixed(4)), Number(r[2].toFixed(4))]),
        ratiosTemoin: cycles1Temoin.map((x) => Number(x.toFixed(4))),
        gain: Number(gain.toFixed(4)),
        assimile,
      },
      generalisation: {
        ratio: Number(moyenne(gens).toFixed(4)),
        ratioTemoin: Number(moyenne(gensTemoin).toFixed(4)),
        gain: Number(gainGen.toFixed(4)),
      },
    });
    console.log(
      `  ${id.padEnd(34)} b${bande} trace c1 ${moyenne(cycles1).toFixed(2)} vs témoin ${moyenne(cycles1Temoin).toFixed(2)} → ×${gain.toFixed(2)} ${assimile ? "ASSIMILÉ" : "faible"} | gén ×${gainGen.toFixed(2)}`,
    );
  }

  console.log(`\nAssimilation TRACE cycle-1 (gain ≥ ${SEUIL_ASSIMILE}) : ${assimiles}/19 domaines.`);

  // Réécriture HONNÊTE du rapport : seules la section sonde et la note de
  // correction changent — tout le reste (échantillons, métabolisme, durée)
  // est conservé du rapport de campagne.
  const rapport = JSON.parse(readFileSync(CHEMIN_RAPPORT, "utf8")) as Record<string, unknown>;
  rapport.sonde = {
    protocole:
      "TRACE : rejeu de 3 échantillons entraînés/domaine à leur horloge exacte, ratio activation bande-porteuse / moyenne des 31 autres lu au CYCLE 1 (protocole de scripts/experience-echelle-it63.ts), comparé à un cortex témoin vierge. GÉNÉRALISATION : textes jamais vus (même vocabulaire, structure distincte), même lecture cycle 1. Les ratios des cycles 2-3 sont rapportés pour transparence sans gain dérivé (le témoin y est ≈ 0 — ratio non interprétable). Gains mesurés, aucune métrique inventée.",
    correction:
      "it.63 — la sonde embarquée de la campagne lisait au cycle 3 (témoin ≈ 0 → gains astronomiques non interprétables) ; la sonde corrigée lit au cycle 1 et a réécrit cette section depuis le checkpoint final (aucun ré-entraînement : échantillons, métabolisme et durée conservés).",
    assimiles,
    total: IDS_VOCATION.length,
    seuilAssimile: SEUIL_ASSIMILE,
    domaines: domainesRapport,
  };
  writeFileSync(CHEMIN_RAPPORT, JSON.stringify(rapport, null, 2) + "\n");
  console.log(`Rapport corrigé : ${CHEMIN_RAPPORT}`);
}

main();
