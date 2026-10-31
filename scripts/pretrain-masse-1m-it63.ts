/**
 * CAMPAGNE DE PRÉ-ENTRAÎNEMENT MASSIF it.63 — « plus d'un million de
 * données par domaine » (demande propriétaire : « réalisé encore un
 * preentrainement de gen3 avec plus de 1 million de données et de dataset
 * dans chaque domaine »).
 *
 * MÉTHODE : entraînement par ondes de domaine (it.57, lib/neural/training/
 * entrainement-ondes) — inchangée. Les 19 domaines de vocation sont
 * entraînés en ÉPOQUES ENTRELACÉES (19 lots de 2000 par époque, ordre de
 * la charte) — ordonnancement dont la discrimination mesurée est
 * supérieure au séquentiel (scripts/experience-discrimination-it63.ts) et
 * qui SURVIT à l'échelle du million (scripts/experience-echelle-it63.ts :
 * trace ×3, généralisation ×2.4 vs témoin sur 2 domaines × 1 M).
 *
 * DONNÉES : 1 002 000 échantillons textuels par domaine (501 époques ×
 * 2000), déterministes et reproductibles, dérivés du vocabulaire RÉEL de
 * la charte de vocation (mission, tâches, mots-clés) complété pour 12
 * domaines par les mots-clés des corpus gen3-domain-datasets (générateur
 * seedé du dépôt, CC-BY-4.0-synthetic-gen3ia). Zéro texte externe, zéro
 * service d'IA distant (règle SNN local).
 *
 * HONNÊTETÉ : chaque échantillon est réellement traité par le cortex
 * (métabolisme cumulé pas à pas) ; la sonde finale (TRACE à l'horloge
 * exacte + GÉNÉRALISATION sur textes jamais vus) est comparée à un cortex
 * témoin vierge ; aucun seuil maquillé — les gains mesurés sont rapportés
 * tels quels, domaine par domaine, bandes partagées comprises (19 domaines
 * sur 8 bandes du vocabulaire fréquentiel).
 *
 * REPRISE : checkpoint toutes les 25 époques dans var/neural/ (état
 * structural complet + progression). Relancer le script reprend là où la
 * campagne s'est arrêtée.
 *
 * Usage : npx tsx scripts/pretrain-masse-1m-it63.ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire, CORTEX_CONFIG_DEFAUTS } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import {
  ecrireArtefactV2,
  lireArtefactV2,
  serialiserEtatV2,
} from "../lib/neural/core/v2/persistance-v2";
import {
  analyserOndeTexte,
  bandeDuDomaine,
  colonnesDepuisOndes,
  entrainerDomainesParOndes,
  porteurBande,
  type ExempleOnde,
} from "../lib/neural/training/entrainement-ondes";
import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";

// ------- Paramètres de la campagne ---------------------------------------
const LOT = 2000; // taille d'un lot par domaine (cap honnête du module ondes)
const EPOQUES = 501; // 501 × 2000 = 1 002 000 échantillons/domaine (> 1M)
const PERIODE_CHECKPOINT = 25;
const CHEMIN_CHECKPOINT = "var/neural/cortex-v2-masse-it63.bin";
const CHEMIN_PROGRESSION = "var/neural/pretrain-masse-progress-it63.json";
const CHEMIN_FINAL = "assets/neural-pretrained/cortex-v2.bin";
const CHEMIN_RAPPORT = "assets/neural-pretrained/preentrainement-masse-1m-it63.json";
const SEUIL_ASSIMILE = 1.25; // gain trace cycle-1 vs témoin (it.61 : 1.36 à 7 éch.)

// ------- Vocabulaire réel -------------------------------------------------
/** Alias vocation → corpus gen3-domain-datasets (mots-clés réels du dépôt). */
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

/** Mots-clés réels des corpus du dépôt (training/gen3-domain-datasets/manifest.json). */
function motsClesCorpus(alias: string[] | undefined): string[] {
  if (!alias || alias.length === 0) return [];
  try {
    const chemin = join(process.cwd(), "training/gen3-domain-datasets/manifest.json");
    const manifeste = JSON.parse(readFileSync(chemin, "utf8")) as {
      domains: Array<{ id: string; mots_cles: string[]; nom_fr: string }>;
    };
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
  const sujets = [
    "gen3",
    "l'opérateur",
    "l'agent autonome",
    "le module de domaine",
    "le cerveau columnnaire",
    "l'index cortical",
  ];
  const verbes = ["analyse", "exécute", "consolide", "vérifie", "orchestre", "évalue", "structure", "mesure"];
  // Objets RÉELS : les tâches de la charte (vocabulaire métier du domaine).
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

/** Échantillon n°i d'un domaine — déterministe, distinct, ~30 tokens. */
function echantillon(v: Vocabulaire, idDomaine: string, i: number): ExempleOnde {
  const sujet = v.sujets[i % v.sujets.length];
  const verbe = v.verbes[(i >> 3) % v.verbes.length];
  const objet = v.objets[(i >> 6) % v.objets.length];
  const cadre = v.cadres[(i >> 9) % v.cadres.length];
  const terme = v.termes.length > 0 ? v.termes[(i >> 12) % v.termes.length] : v.label;
  const texte = `${v.label} — échantillon ${i} : ${sujet} ${verbe} ${objet} (${cadre}) ; vocabulaire du domaine : ${terme}, porteur ${porteurBande(bandeDuDomaine(idDomaine)).toFixed(2)} rad/cycle.`;
  return { texte, domaine: idDomaine };
}

/** Texte JAMAIS vu (généralisation) — structure distincte des échantillons. */
function texteInconnu(domaine: (typeof DOMAINES_VOCATION)[number], k: number): string {
  return `sonde de généralisation ${k} — ${domaine.label} : le porteur fréquentiel traverse la bande corticale, l'écho columnnaire mesure la plasticité consolidée de ce domaine jamais relu, structure distincte des échantillons d'entraînement.`;
}

// ------- Progression -------------------------------------------------------
interface Progression {
  epoque: number;
  horloge: number;
  echantillonsParDomaine: Record<string, number>;
  metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number };
  dureeMs: number;
}

function chargerProgression(): Progression | null {
  if (!existsSync(CHEMIN_PROGRESSION)) return null;
  try {
    return JSON.parse(readFileSync(CHEMIN_PROGRESSION, "utf8")) as Progression;
  } catch {
    return null;
  }
}

// ------- Sonde -------------------------------------------------------------
function ratioPorteur(cortex: CortexColumnnaire, texte: string, horloge: number, bande: number): number {
  const paquets = analyserOndeTexte(texte, horloge);
  const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes, bande, cortex.config.bandes);
  // Lecture au CYCLE 1 (premier pas d'injection) — au cycle 3 le témoin
  // vierge est ≈ 0 et le ratio cesse d'être interprétable.
  cortex.pas(injections, horloge + 1);
  const act = cortex.activationBandes();
  let somme = 0;
  for (let b = 0; b < act.length; b++) if (b !== bande) somme += act[b] ?? 0;
  return (act[bande] ?? 0) / Math.max(1e-12, somme / (act.length - 1));
}

function moyenne(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
}

// ------- Campagne ----------------------------------------------------------
async function main(): Promise<void> {
  console.log("=== PRÉ-ENTRAÎNEMENT MASSIF it.63 — 19 domaines × 1 002 000 échantillons ===");
  console.log(`Cortex : ${CORTEX_CONFIG_DEFAUTS.colonnes.toLocaleString("fr-FR")} colonnes, ${CORTEX_CONFIG_DEFAUTS.voisins} voisins, ${CORTEX_CONFIG_DEFAUTS.bandes} bandes.`);
  const debutCampagne = Date.now();

  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const champ = new ChampCorticalGen3();
  const vocabulaires = new Map<string, Vocabulaire>();
  for (const domaine of DOMAINES_VOCATION) vocabulaires.set(domaine.id, vocabulaireDuDomaine(domaine));

  // Structure honnête : 19 domaines sur 8 bandes du vocabulaire fréquentiel.
  const bandes = new Map<string, number>();
  for (const id of IDS_VOCATION) bandes.set(id, bandeDuDomaine(id));
  const repartition = new Map<number, number>();
  for (const b of bandes.values()) repartition.set(b, (repartition.get(b) ?? 0) + 1);
  console.log(`Bandes-porteuses : ${[...repartition.entries()].map(([b, n]) => `b${b}×${n}`).join(", ")}`);

  // Reprise éventuelle.
  const progression = chargerProgression();
  let epoqueDebut = 0;
  let horloge = 0;
  const echantillonsParDomaine: Record<string, number> = {};
  for (const id of IDS_VOCATION) echantillonsParDomaine[id] = 0;
  const metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0 };
  if (progression && existsSync(CHEMIN_CHECKPOINT)) {
    const etat = lireArtefactV2(CHEMIN_CHECKPOINT);
    if (etat && etat.colonnes === cortex.config.colonnes) {
      cortex.importerPoids(etat.poids);
      champ.seedEntrainement = etat.seedEntrainement;
      champ.importerModulation(etat.modulationRegionale);
      epoqueDebut = progression.epoque;
      horloge = progression.horloge;
      for (const id of IDS_VOCATION) echantillonsParDomaine[id] = progression.echantillonsParDomaine[id] ?? 0;
      metabolisme.evaluees = progression.metabolisme.evaluees;
      metabolisme.reposes = progression.metabolisme.reposes;
      metabolisme.transmissions = progression.metabolisme.transmissions;
      metabolisme.ms = progression.metabolisme.ms;
      console.log(`REPRISE : époque ${epoqueDebut}/${EPOQUES}, horloge ${horloge.toLocaleString("fr-FR")}, ${(Object.values(echantillonsParDomaine).reduce((a, x) => a + x, 0) / 1e6).toFixed(2)} M échantillons déjà traités.`);
    }
  }

  // Sondes TRACE : 3 échantillons/domaine avec leur horloge exacte d'entraînement.
  const horlogesTrace = new Map<string, Array<[string, number]>>();
  for (const id of IDS_VOCATION) horlogesTrace.set(id, []);
  const indicesTrace = [5, 500_005, 1_001_995];

  const t0 = Date.now();
  for (let e = epoqueDebut; e < EPOQUES; e++) {
    for (const id of IDS_VOCATION) {
      const v = vocabulaires.get(id)!;
      const lot: ExempleOnde[] = [];
      for (let i = 0; i < LOT; i++) {
        const idx = e * LOT + i;
        lot.push(echantillon(v, id, idx));
        if (indicesTrace.includes(idx)) horlogesTrace.get(id)!.push([lot[lot.length - 1].texte, horloge + 3 * i]);
      }
      const r = entrainerDomainesParOndes(cortex, champ, lot, { maxParDomaine: LOT, horlogeInitiale: horloge });
      horloge += 3 * LOT;
      echantillonsParDomaine[id] += r.totalEchantillons;
      metabolisme.evaluees += r.metabolisme.evaluees;
      metabolisme.reposes += r.metabolisme.reposes;
      metabolisme.transmissions += r.metabolisme.transmissions;
      metabolisme.ms += r.metabolisme.ms;
    }
    if ((e + 1) % PERIODE_CHECKPOINT === 0 || e === EPOQUES - 1) {
      const total = Object.values(echantillonsParDomaine).reduce((a, x) => a + x, 0);
      const ecoule = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  époque ${e + 1}/${EPOQUES} — ${(total / 1e6).toFixed(2)} M échantillons — ${ecoule} s — horloge ${horloge.toLocaleString("fr-FR")}`);
      mkdirSync("var/neural", { recursive: true });
      await ecrireArtefactV2(CHEMIN_CHECKPOINT, {
        colonnes: cortex.config.colonnes,
        voisins: cortex.config.voisins,
        bandes: cortex.config.bandes,
        seed: cortex.config.seed,
        seedEntrainement: champ.seedEntrainement,
        epochsConsolides: e + 1,
        samplesConsolides: total,
        poids: cortex.exporterPoids(),
        modulationRegionale: champ.modulationRegionale(),
      });
      writeFileSync(
        CHEMIN_PROGRESSION,
        JSON.stringify(
          {
            epoque: e + 1,
            horloge,
            echantillonsParDomaine,
            metabolisme,
            dureeMs: Date.now() - debutCampagne,
          } satisfies Progression,
          null,
          2,
        ) + "\n",
      );
    }
  }

  const dureeEntrainementMs = Date.now() - debutCampagne;
  const totalEchantillons = Object.values(echantillonsParDomaine).reduce((a, x) => a + x, 0);
  console.log(`Entraînement terminé : ${totalEchantillons.toLocaleString("fr-FR")} échantillons en ${(dureeEntrainementMs / 60000).toFixed(1)} min.`);

  // ---- SONDE D'ASSIMILATION (honnête : trained vs témoin vierge) ---------
  console.log("\nSonde d'assimilation (TRACE à l'horloge exacte + GÉNÉRALISATION jamais vu)…");
  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const domainesRapport: Array<{
    domaine: string;
    bande: number;
    porteurFrequence: number;
    echantillons: number;
    trace: { ratios: number[]; ratiosTemoin: number[]; gain: number; assimile: boolean };
    generalisation: { ratio: number; ratioTemoin: number; gain: number };
  }> = [];

  for (const domaine of DOMAINES_VOCATION) {
    const id = domaine.id;
    const bande = bandes.get(id)!;
    const sondes = horlogesTrace.get(id)!;
    const ratios = sondes.map(([txt, hr]) => ratioPorteur(cortex, txt, hr, bande));
    const ratiosTemoin = sondes.map(([txt, hr]) => ratioPorteur(temoin, txt, hr, bande));
    const gain = moyenne(ratios) / Math.max(1e-9, moyenne(ratiosTemoin));
    const gens = [0, 1].map((k) => ratioPorteur(cortex, texteInconnu(domaine, k), 0, bande));
    const gensTemoin = [0, 1].map((k) => ratioPorteur(temoin, texteInconnu(domaine, k), 0, bande));
    const gainGen = moyenne(gens) / Math.max(1e-9, moyenne(gensTemoin));
    domainesRapport.push({
      domaine: id,
      bande,
      porteurFrequence: porteurBande(bande),
      echantillons: echantillonsParDomaine[id],
      trace: { ratios, ratiosTemoin, gain, assimile: gain >= SEUIL_ASSIMILE },
      generalisation: { ratio: moyenne(gens), ratioTemoin: moyenne(gensTemoin), gain: gainGen },
    });
    console.log(
      `  ${id.padEnd(34)} b${bande} éch=${echantillonsParDomaine[id].toLocaleString("fr-FR")} trace×${gain.toFixed(2)} ${gain >= SEUIL_ASSIMILE ? "ASSIMILÉ" : "faible"} gén×${gainGen.toFixed(2)}`,
    );
  }

  const assimiles = domainesRapport.filter((d) => d.trace.assimile).length;
  console.log(`\nAssimilation TRACE (gain ≥ ${SEUIL_ASSIMILE}) : ${assimiles}/${IDS_VOCATION.length} domaines.`);
  console.log(`Généralisation (textes jamais vus) : gain moyen ×${(domainesRapport.reduce((a, d) => a + d.generalisation.gain, 0) / domainesRapport.length).toFixed(2)}.`);

  // ---- ARTEFACTS FINAUX ----------------------------------------------------
  const etatFinal = serialiserEtatV2({
    colonnes: cortex.config.colonnes,
    voisins: cortex.config.voisins,
    bandes: cortex.config.bandes,
    seed: cortex.config.seed,
    seedEntrainement: champ.seedEntrainement,
    epochsConsolides: EPOQUES,
    samplesConsolides: totalEchantillons,
    poids: cortex.exporterPoids(),
    modulationRegionale: champ.modulationRegionale(),
  });
  mkdirSync("var/neural", { recursive: true });
  writeFileSync(CHEMIN_CHECKPOINT, etatFinal);
  mkdirSync("assets/neural-pretrained", { recursive: true });
  writeFileSync(CHEMIN_FINAL, etatFinal);
  writeFileSync(
    CHEMIN_RAPPORT,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        methode: "EOD — Entraînement par Ondes de Domaine (it.57), campagne massive it.63",
        contexte: "it.63 — pré-entraînement massif : plus d'un million de données par domaine (demande propriétaire)",
        environnement: { type: "local-sandbox", serviceIaDistant: false },
        cortex: { colonnes: cortex.config.colonnes, voisins: cortex.config.voisins, bandes: cortex.config.bandes },
        options: { lot: LOT, epoques: EPOQUES, cyclesParEchantillon: 3, lrBoost: 0.15, seuilAssimile: SEUIL_ASSIMILE, ordonnancement: "époques entrelacées (ordre de la charte)" },
        sources: {
          description: "Échantillons textuels déterministes dérivés de la charte de vocation (mission, tâches, mots-clés) + mots-clés réels des corpus gen3-domain-datasets (générateur seedé du dépôt) — aucun texte externe.",
          aliasCorpus: ALIAS_CORPUS,
          domainesSansCorpus: IDS_VOCATION.filter((id) => !(id in ALIAS_CORPUS)),
        },
        totalEchantillons,
        echantillonsParDomaine,
        horlogeFinale: horloge,
        metabolisme,
        sonde: {
          protocole: "TRACE : rejeu de 3 échantillons entraînés/domaine à leur horloge exacte, ratio activation bande-porteuse / moyenne des 31 autres, comparé à un cortex témoin vierge. GÉNÉRALISATION : textes jamais vus (même vocabulaire, structure distincte). Gains rapportés tels quels — aucune métrique inventée.",
          assimiles,
          total: IDS_VOCATION.length,
          seuilAssimile: SEUIL_ASSIMILE,
          domaines: domainesRapport,
        },
        dureeMs: Date.now() - debutCampagne,
        dureeEntrainementMs,
      },
      null,
      2,
    ) + "\n",
  );
  cpSync(CHEMIN_RAPPORT, join(process.cwd(), "var/neural/preentrainement-masse-1m-it63.json"));
  console.log(`\nArtefact cortical : ${CHEMIN_FINAL} (${(etatFinal.length / 1e6).toFixed(1)} Mo)`);
  console.log(`Rapport honnête : ${CHEMIN_RAPPORT}`);
  console.log(`Durée totale : ${((Date.now() - debutCampagne) / 60000).toFixed(1)} min.`);
}

void main();
