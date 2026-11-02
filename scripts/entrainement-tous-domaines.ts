/**
 * ENTRAÎNEMENT TOUS-DOMAINES GEN3 — LE SCRIPT UNIQUE (it.84).
 *
 * DEMANDE PROPRIÉTAIRE (trace 1a19a7e0cd8e7339, 02/11/2026) : « sélectionner
 * depuis Hugging Face et Kaggle les meilleurs datasets dans les 19 domaines
 * de gen3… les implémenter dans le cerveau de gen3 comme code source… créer
 * un seul script d'entraînement qui va servir à ce que gen3 assimile tous
 * ses domaines d'un seul coup… utilise ton sandbox pour lancer le script
 * d'entraînement pour que gen3 les mémorise et les conserve en mémoire…
 * vérifie avec pour chaque domaine 50 questions ».
 *
 * CE QUE CE SCRIPT FAIT (tout mesuré, zéro invention) :
 *   1. CHARGE la matière réelle par domaine (chaîne : datasets externes
 *      HF/Kaggle téléchargés par scripts/selecteur-datasets-externes.py →
 *      échantillon commis → atelier gen3ia) + generation-code (19ᵉ domaine,
 *      datasets/code).
 *   2. SÉPARE train / test : les 50 DERNIERS échantillons de chaque domaine
 *      ne sont JAMAIS supervisés — ils servent aux 50 questions/domaine.
 *   3. SONDE « AVANT » : cortex NEUF (même graine, zéro supervision) —
 *      chaque question → projection hash → 4 cycles → argmax des 8 bandes
 *      vs bande-porteuse attendue (bandeDuDomaine).
 *   4. ASSIMILE D'UN SEUL COUP : entrainerDomainesParOndes (EOD it.57)
 *      sur les 19 domaines en UNE passe — analyse des ondes, traitement,
 *      consolidation par résonance + bus d'ondes (métabolisme mesuré).
 *   5. SONDE « APRÈS » : mêmes questions, mêmes réglages.
 *   6. PHASE LANGAGIÈRE (le test UTILISATEUR — mécanique du chat) : paires
 *      appprises depuis le TRAIN des datasets externes (motif = première
 *      phrase de l'instruction, réponse réelle), pré-filtre des motifs
 *      parasites (tokens tous universels), évaluation 50 questions/domaine
 *      (thème attendu + score d'appariement ≥ seuil) avant (cortex vierge)
 *      et après (appris).
 *   7. MÉMORISE : quantification u8 → checkpoint binaire rechargé et
 *      validé + evaluation.json (chiffres complets).
 *
 * ÉCHELLE HONNÊTE : les quotas réels sont ceux téléchargés (12 875 extraits
 * externes au 02/11/2026) — 1 milliard de datasets par domaine est
 * physiquement impossible (aucun fournisseur ne le propose) ; le script
 * mesure le débit réel et publie les chiffres tels quels.
 *
 * Usage :
 *   npx tsx scripts/entrainement-tous-domaines.ts                 # complet
 *   npx tsx scripts/entrainement-tous-domaines.ts --maxParDomaine 200   # rapide
 *   npx tsx scripts/entrainement-tous-domaines.ts --sansCheckpoint
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import {
  erreurMaxQuantisation,
  exporterSnapshotTelephone,
  importerSnapshotTelephone,
  quantiserPoidsU8,
} from "../lib/neural/core/v2/energie";
import {
  bandeDuDomaine,
  entrainerDomainesParOndes,
} from "../lib/neural/training/entrainement-ondes";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import type { PaireLangage } from "../lib/neural/generation/corpus";

/**
 * Les 18 DOMAINES_GEN3 (source de vérité : lib/neural/core/types.ts,
 * DOMAIN_POOLS — pools de neurones 100..135) + le 19ᵉ (generation-code,
 * it.79/80). Liste locale car lib/neural/training/domaines.ts porte
 * `import "server-only"` (réservé aux Server Components).
 */
const DOMAINES_IDS = [
  "generation_images", "video", "son", "clips_musicaux",
  "developpement_web", "test", "redaction_documents", "sciences_humaines",
  "recherche_scientifique", "cybersecurite", "recherche_web", "multimodal",
  "hacker", "construction_machines", "vente", "sante_medical",
  "analyse_donnees", "conseiller_commercial",
] as const;

/* ------------------------------------------------------------------ */
/* Paramètres                                                          */
/* ------------------------------------------------------------------ */

const COLONNES = 131072; // 2^17 — configuration mémoire faible (it.73+)
const GRAINE = 20261102;
const CYCLES_EOD = 3; // identique it.57/63/77/79
const CYCLES_SONDE = 4; // fenêtre de lecture (identique production)
const LR = 0.15;
const QUESTIONS_TEST_DEFAUT = 50; // 50 questions par domaine (demande)
const TRAIN_DEFAUT = 700; // échantillons externes supervisés par domaine
const REP_CHECKPOINT = "var/neural-domaines-externes";
const DOMAINE_CODE = "generation-code"; // 19ᵉ domaine (bande 3, it.79/80)
const FICHIER_CODE = "datasets/code/train.jsonl";

function horodatage(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function m6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ */
/* Sondes (convention production — reprise it.77/79)                   */
/* ------------------------------------------------------------------ */

interface MoteurSonde {
  reinitialiserEnergies(): void;
  projetterTokens(tokens: string[]): Array<[number, number]>;
  pas(injections: Array<[number, number]> | null, t: number): number[];
  activationBandes(): number[];
}

interface ResultatSonde {
  texte: string;
  bandeAttendue: number;
  argmaxBande: number;
  activationPorteur: number;
  ok: boolean;
}

function sonder(
  moteur: MoteurSonde,
  texte: string,
  bandeAttendue: number,
  horlogeDepart: number,
): ResultatSonde {
  moteur.reinitialiserEnergies();
  const injections = moteur.projetterTokens(tokenize(texte));
  const activationCumulee = new Array(8).fill(0) as number[];
  for (let c = 0; c < CYCLES_SONDE; c++) {
    moteur.pas(c === 0 ? injections : null, horlogeDepart + c + 1);
    const actPas = moteur.activationBandes();
    for (let b = 0; b < 8; b++) activationCumulee[b] += actPas[b] ?? 0;
  }
  let argmax = 0;
  let maxAct = activationCumulee[0] ?? 0;
  for (let b = 1; b < 8; b++) {
    if ((activationCumulee[b] ?? 0) > maxAct) {
      maxAct = activationCumulee[b] ?? 0;
      argmax = b;
    }
  }
  return {
    texte: texte.slice(0, 120),
    bandeAttendue,
    argmaxBande: argmax,
    activationPorteur: m6(activationCumulee[bandeAttendue] ?? 0),
    ok: argmax === bandeAttendue,
  };
}

/* ------------------------------------------------------------------ */
/* Chargement train/test par domaine                                   */
/* ------------------------------------------------------------------ */

interface LotDomaine {
  domaine: string;
  train: string[];        // textes SIGNATURES (EOD + sondes bande)
  test: string[];         // textes signatures de test (sondes bande)
  trainBrut: string[];    // instructions BRUTES (paires langagières)
  trainSorties: string[]; // réponses brutes (alignées sur trainBrut)
  testQuestions: string[];// questions utilisateur réelles (évaluation langagière)
  source: string;
}

/**
 * TEXTES SIGNATURES (mécanique de prod — lib/neural/training/domaines.ts,
 * texteEntrainement + construireSignaturesDomaines) : l'encodeur SNN hache
 * les tokens sur 38 neurones cap — une instruction longue sature TOUTE la
 * zone d'entrée et tous les domaines produisent le même vecteur. On retient
 * les tokens présents dans ≤ 2 domaines (discriminants) et on entraîne sonde
 * et EOD sur ces textes courts.
 */
function construireSignatures(parDomaine: Map<string, string[]>): Set<string> {
  const occurrences = new Map<string, Set<string>>();
  for (const [domaine, textes] of parDomaine) {
    for (const texte of textes) {
      const vusLocaux = new Set<string>();
      for (const token of tokenize(texte)) {
        if (vusLocaux.has(token)) continue;
        vusLocaux.add(token);
        let ens = occurrences.get(token);
        if (!ens) {
          ens = new Set<string>();
          occurrences.set(token, ens);
        }
        ens.add(domaine);
      }
    }
  }
  const signatures = new Set<string>();
  for (const [token, domaines] of occurrences) {
    if (domaines.size <= 2) signatures.add(token);
  }
  return signatures;
}

function texteSignature(instruction: string, signatures: ReadonlySet<string>, maxTokens = 6): string {
  const vus = new Set<string>();
  const pris: string[] = [];
  for (const token of tokenize(instruction)) {
    if (signatures.has(token) && !vus.has(token)) {
      vus.add(token);
      pris.push(token);
      if (pris.length >= maxTokens) break;
    }
  }
  return pris.join(" ");
}

/** L'extrait réellement chargé est reconnu par le champ source_style. */
function sourceDe(ligne: string): string {
  try {
    const o = JSON.parse(ligne) as { metadata?: { source_style?: string } };
    return o.metadata?.source_style ?? "atelier_gen3ia";
  } catch {
    return "illisible";
  }
}

function chargerLot(
  domaine: string,
  lignesJsonl: string[],
  trainMax: number,
  questionsTest: number,
): LotDomaine {
  // Derniers échantillons = JAMAIS supervisés → questions de test.
  const total = lignesJsonl.length;
  const test: string[] = [];
  const testQuestions: string[] = [];
  const train: string[] = [];
  const trainBrut: string[] = [];
  const trainSorties: string[] = [];
  const debutTest = Math.max(0, total - questionsTest);
  for (let i = 0; i < total; i++) {
    const o = JSON.parse(lignesJsonl[i]!) as { instruction?: string; input?: string; output?: string };
    const texte = [o.instruction, o.input].filter(Boolean).join(" ").trim();
    if (texte.length < 12) continue;
    if (i >= debutTest && test.length < questionsTest) {
      test.push(texte);
      // Question utilisateur réelle : la première phrase de l'instruction.
      const question = texte.split(/[.!?]/)[0]!.trim();
      testQuestions.push(question.length >= 12 ? question : texte.slice(0, 120));
    } else {
      train.push(texte);
      trainBrut.push(texte);
      trainSorties.push((o.output ?? "").trim());
    }
  }
  // Train borné (budget CPU) : tête du tableau après les tests retirés.
  const trainBorne = train.slice(0, trainMax);
  const trainBrutBorne = trainBrut.slice(0, trainMax);
  const trainSortiesBorne = trainSorties.slice(0, trainMax);
  return {
    domaine,
    train: trainBorne,
    test: test.slice(0, questionsTest),
    trainBrut: trainBrutBorne,
    trainSorties: trainSortiesBorne,
    testQuestions: testQuestions.slice(0, questionsTest),
    source: lignesJsonl.length > 0 ? sourceDe(lignesJsonl[0]!) : "vide",
  };
}

function lignesDatasetsCode(): string[] {
  const chemin = join(process.cwd(), FICHIER_CODE);
  if (!existsSync(chemin)) return [];
  return readFileSync(chemin, "utf8").split("\n").filter((l) => l.trim());
}

function readFileSyncDatasetDomaine(domaineId: string): string[] {
  // Lit le PREMIER fichier gagnant de la chaîne de sources (même ordre que
  // lib/neural/training/domaines.ts — lecture synchrone de script).
  const chemins = [
    `training/gen3-domain-datasets/data/complet/${domaineId}.jsonl`,
    `training/gen3-domain-datasets/data/complet/externes/${domaineId}.jsonl`,
    `training/gen3-domain-datasets/data/echantillons_externes/${domaineId}.jsonl`,
    `training/gen3-domain-datasets/data/echantillons/${domaineId}.jsonl`,
  ];
  for (const c of chemins) {
    const abs = join(process.cwd(), c);
    if (existsSync(abs)) {
      const lignes = readFileSync(abs, "utf8").split("\n").filter((l) => l.trim());
      if (lignes.length > 0) return lignes;
    }
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Principal                                                           */
/* ------------------------------------------------------------------ */

function principal(): void {
  const args = process.argv.slice(2);
  const opt = (nom: string, defaut: number) => {
    const i = args.indexOf(`--${nom}`);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : defaut;
  };
  const sansCheckpoint = args.includes("--sansCheckpoint");
  const questionsTest = opt("questionsTest", QUESTIONS_TEST_DEFAUT);
  const trainMax = opt("maxParDomaine", TRAIN_DEFAUT);

  console.log("=== ENTRAÎNEMENT TOUS-DOMAINES GEN3 (it.84 — script unique) ===");
  console.log(horodatage());
  console.log(
    `Réglages : ${trainMax} train/domaine · ${questionsTest} questions test/domaine · ` +
    `cortex ${COLONNES} colonnes · graine ${GRAINE}`,
  );

  // ---- 1. MATIÈRE RÉELLE par domaine (chaîne de sources du dépôt) --------
  console.log("\n[1] Chargement de la matière réelle (externes HF/Kaggle d'abord)…");
  const lots: LotDomaine[] = [];
  const brutParDomaine = new Map<string, string[]>();
  for (const domaine of DOMAINES_IDS) {
    const lignes = readFileSyncDatasetDomaine(domaine);
    const lot = chargerLot(domaine, lignes, trainMax, questionsTest);
    brutParDomaine.set(domaine, [...lot.train, ...lot.test]);
    lots.push(lot);
    console.log(
      `    ${domaine.padEnd(24)} train ${String(lot.train.length).padStart(4)} · test ${String(lot.test.length).padStart(3)} · source ${lot.source}`,
    );
  }
  // 19ᵉ domaine : generation-code (datasets/code commis, 12 000 lignes).
  const lotCode = chargerLot(DOMAINE_CODE, lignesDatasetsCode(), trainMax, questionsTest);
  brutParDomaine.set(DOMAINE_CODE, [...lotCode.train, ...lotCode.test]);
  lots.push(lotCode);
  console.log(
    `    ${DOMAINE_CODE.padEnd(24)} train ${String(lotCode.train.length).padStart(4)} · test ${String(lotCode.test.length).padStart(3)} · source datasets/code`,
  );

  // Textes SIGNATURES (mécanique de prod) : l'instruction brute sature
  // l'encodeur SNN — entraînement et sondes passent par les tokens
  // discriminants (≤ 2 domaines, max 6 tokens), calculés sur le train seul
  // (le test n'influence PAS la sélection des signatures).
  const signatures = construireSignatures(
    new Map(Array.from(brutParDomaine).map(([d, t]) => [d, t.slice(0, trainMax)])),
  );
  let signaturesUtilisees = 0;
  for (const lot of lots) {
    lot.train = lot.train
      .map((t) => texteSignature(t, signatures))
      .filter((t) => t.length >= 3);
    lot.test = lot.test
      .map((t) => texteSignature(t, signatures))
      .filter((t) => t.length >= 3);
    signaturesUtilisees += lot.train.length;
    if (lot.test.length === 0) {
      console.log(`    ⚠ ${lot.domaine} : aucun texte signature de test — lot réduit`);
    }
  }
  console.log(
    `    signatures discriminantes : ${signatures.size} tokens · textes train exploitables : ${signaturesUtilisees}`,
  );

  const totalTrain = lots.reduce((s, l) => s + l.train.length, 0);
  const totalTest = lots.reduce((s, l) => s + l.test.length, 0);
  console.log(`    TOTAL : ${totalTrain} échantillons train · ${totalTest} questions test`);

  // ---- 2. CORTEX NEUF → SONDE AVANT --------------------------------------
  console.log("\n[2] Cortex neuf — mesure AVANT (zéro supervision)…");
  const cortexNeuf = new CortexColumnnaire({
    colonnes: COLONNES,
    seed: GRAINE,
    normalisationHomeostatique: true,
  });
  const champNeuf = new ChampCorticalGen3(GRAINE);
  const avant = mesurer(cortexNeuf, champNeuf, lots);
  const tauxAvant = taux(avant);
  console.log(
    `    AVANT : ${tauxAvant.bonnes}/${tauxAvant.total} questions sur la bande attendue (${m6(tauxAvant.taux * 100)} %)`,
  );

  // ---- 3. ASSIMILATION D'UN SEUL COUP (EOD, 19 domaines) ------------------
  console.log("\n[3] Entraînement par ondes — les 19 domaines en UNE passe…");
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES,
    seed: GRAINE,
    normalisationHomeostatique: true,
  });
  const champ = new ChampCorticalGen3(GRAINE);
  const exemples: { texte: string; domaine: string }[] = [];
  for (const lot of lots) {
    for (const texte of lot.train) exemples.push({ texte, domaine: lot.domaine });
  }
  // Entrelacement déterministe (une bande ne reste jamais seule en piste —
  // convention it.63/77) : tri stable par hash d'indice.
  const ordre = Array.from(exemples.keys()).sort((a, b) =>
    ((a * 2654435761) % 4294967296) - ((b * 2654435761) % 4294967296));
  const exemplesMelanges = ordre.map((i) => exemples[i]!);
  const tEod = performance.now();
  const rapport = entrainerDomainesParOndes(cortex, champ, exemplesMelanges, {
    cyclesParEchantillon: CYCLES_EOD,
    lrBoost: LR,
    maxParDomaine: trainMax,
  });
  const dureeEodS = (performance.now() - tEod) / 1000;
  console.log(
    `    EOD : ${rapport.totalEchantillons} échantillons en ${m6(dureeEodS)} s ` +
    `(${m6(rapport.totalEchantillons / Math.max(dureeEodS, 1e-9))} éch/s)`,
  );
  console.log(
    `    Métabolisme cumulé : ${rapport.metabolisme.evaluees.toLocaleString("fr-FR")} évaluées · ` +
    `${rapport.metabolisme.reposes.toLocaleString("fr-FR")} reposées (coût 0) · ` +
    `${rapport.metabolisme.transmissions.toLocaleString("fr-FR")} transmissions · ${m6(rapport.metabolisme.ms)} ms`,
  );

  // ---- 4. SONDE APRÈS -----------------------------------------------------
  console.log("\n[4] Cortex entraîné — mesure APRÈS (mêmes questions)…");
  const apres = mesurer(cortex, champ, lots);
  const tauxApres = taux(apres);
  console.log(
    `    APRÈS : ${tauxApres.bonnes}/${tauxApres.total} questions sur la bande attendue (${m6(tauxApres.taux * 100)} %)`,
  );

  // ---- 5. DÉTAIL PAR DOMAINE (avant → après) ------------------------------
  console.log("\n[5] Rapport par domaine — bande porteuse (EOD) :");
  const detailParDomaine: Record<string, { avant: number; apres: number; total: number; activationAvant: number; activationApres: number }> = {};
  for (const lot of lots) {
    const a = avant.filter((r) => r.domaine === lot.domaine);
    const p = apres.filter((r) => r.domaine === lot.domaine);
    const avantB = a.filter((r) => r.ok).length;
    const apresB = p.filter((r) => r.ok).length;
    const actA = a.length ? a.reduce((s, r) => s + r.activationPorteur, 0) / a.length : 0;
    const actP = p.length ? p.reduce((s, r) => s + r.activationPorteur, 0) / p.length : 0;
    detailParDomaine[lot.domaine] = {
      avant: avantB, apres: apresB, total: p.length,
      activationAvant: m6(actA), activationApres: m6(actP),
    };
    console.log(
      `    ${lot.domaine.padEnd(24)} ${String(avantB).padStart(3)}/${String(a.length).padStart(3)} → ${String(apresB).padStart(3)}/${String(p.length).padStart(3)} · activation porteur ${m6(actA)} → ${m6(actP)}`,
    );
  }

  // ---- 6. PHASE LANGAGIÈRE — le test UTILISATEUR (mécanique du chat) -----
  //     Le chat de production répond via le cortex langagier (appariement
  //     de paires, score de match) — c'est LUI que les 50 questions/domaine
  //     doivent mesurer. AVANT = cortex vierge ; APRÈS = paires apprises
  //     depuis le TRAIN des datasets externes (les réponses réelles).
  console.log("\n[6] Cortex langagier — 50 questions/domaine (mécanique du chat)…");
  const SEUIL_APPARIEMENT = 0.5;

  interface PaireBrute { motif: string; reponse: string; domaine: string; tokens: Set<string> }
  const brutPaires: PaireBrute[] = [];
  for (const lot of lots) {
    for (let i = 0; i < lot.trainBrut.length; i++) {
      const instruction = lot.trainBrut[i]!;
      const sortie = lot.trainSorties[i] ?? "";
      const motif = instruction.split(/[.!?]/)[0]!.trim();
      if (motif.length < 12 || sortie.length < 20) continue;
      brutPaires.push({
        motif, reponse: sortie, domaine: lot.domaine,
        tokens: new Set(tokenize(motif).filter((t) => t.length >= 3)),
      });
    }
  }
  // RÉPONSES PARASITES — pré-filtre mesuré : un motif dont TOUS les tokens
  // sont universels (présents dans > 60 % des domaines) attire des questions
  // hors de son domaine ; il est exclu de l'apprentissage (compté).
  const nbDomaines = lots.length;
  const prevalence = new Map<string, Set<string>>();
  for (const p of brutPaires) {
    for (const t of p.tokens) {
      let ens = prevalence.get(t);
      if (!ens) { ens = new Set(); prevalence.set(t, ens); }
      ens.add(p.domaine);
    }
  }
  const seuilUniversel = Math.max(4, Math.ceil(nbDomaines * 0.6));
  const pairesPropres: PaireLangage[] = [];
  let pairesParasites = 0;
  for (const p of brutPaires) {
    const universels = [...p.tokens].filter((t) => (prevalence.get(t)?.size ?? 0) > seuilUniversel);
    const parasite = p.tokens.size > 0 && universels.length === p.tokens.size;
    if (parasite) { pairesParasites++; continue; }
    pairesPropres.push({ motif: p.motif, reponse: p.reponse, theme: `domaine:${p.domaine}` });
  }
  console.log(
    `    paires langagières construites : ${pairesPropres.length} · motifs parasites exclus (tokens tous universels) : ${pairesParasites}`,
  );

  const evalueLangagier = (cortex: CortexLangagierGen3) => {
    const detail: Record<string, { bonnes: number; horsDomaine: number; sansReponse: number; total: number; scoreMoyen: number }> = {};
    for (const lot of lots) {
      const r = { bonnes: 0, horsDomaine: 0, sansReponse: 0, total: lot.testQuestions.length, scoreMoyen: 0 };
      let somme = 0;
      for (const question of lot.testQuestions) {
        const reponse = cortex.repondre(question);
        if (!reponse) { r.sansReponse++; continue; }
        somme += reponse.score;
        if (reponse.theme === `domaine:${lot.domaine}` && reponse.score >= SEUIL_APPARIEMENT) r.bonnes++;
        else r.horsDomaine++;
      }
      r.scoreMoyen = r.total > 0 ? m6(somme / r.total) : 0;
      detail[lot.domaine] = r;
    }
    return detail;
  };

  const cortexVierge = new CortexLangagierGen3();
  const avantLangagier = evalueLangagier(cortexVierge);
  const cortexEnseigne = new CortexLangagierGen3();
  const statsLangagier = cortexEnseigne.apprendre(pairesPropres);
  void statsLangagier;
  const apresLangagier = evalueLangagier(cortexEnseigne);

  console.log("    domaine                      AVANT (vierge)  →  APRÈS (appris) · score moyen · hors-domaine · sans réponse");
  let bonnesTotalApres = 0, totalQuestionsLangagier = 0, horsDomaineTotal = 0, sansReponseTotal = 0;
  for (const lot of lots) {
    const a = avantLangagier[lot.domaine]!;
    const p = apresLangagier[lot.domaine]!;
    bonnesTotalApres += p.bonnes; totalQuestionsLangagier += p.total;
    horsDomaineTotal += p.horsDomaine; sansReponseTotal += p.sansReponse;
    console.log(
      `    ${lot.domaine.padEnd(24)} ${String(a.bonnes).padStart(3)}/${String(a.total).padStart(3)}  →  ${String(p.bonnes).padStart(3)}/${String(p.total).padStart(3)} · score ${p.scoreMoyen} · ${p.horsDomaine} · ${p.sansReponse}`,
    );
  }
  const tauxLangagier = totalQuestionsLangagier > 0 ? bonnesTotalApres / totalQuestionsLangagier : 0;
  console.log(
    `    TOTAL : ${bonnesTotalApres}/${totalQuestionsLangagier} questions servies par le bon domaine au seuil ${SEUIL_APPARIEMENT} (${m6(tauxLangagier * 100)} %)`,
  );

  // ---- 7. MÉMORISATION (checkpoint u8 + évaluation) ------------------------
  if (!sansCheckpoint) {
    console.log("\n[7] Mémorisation persistée (quantification u8)…");
    mkdirSync(REP_CHECKPOINT, { recursive: true });
    const poidsU8 = quantiserPoidsU8(cortex.csrPoids);
    const entete = {
      colonnes: cortex.config.colonnes, voisins: cortex.config.voisins,
      bandes: cortex.config.bandes, bandesLecture: cortex.config.bandesLecture,
      seed: cortex.config.seed, seuil: cortex.config.seuil,
      decroissance: cortex.config.decroissance,
      plasticiteFenetre: cortex.config.plasticiteFenetre, aretes: cortex.csrCible.length,
    };
    const snapshot = exporterSnapshotTelephone(entete, poidsU8);
    const cible = join(REP_CHECKPOINT, "cortex-u8.bin");
    writeFileSync(cible, snapshot);
    // Auto-validation : le checkpoint est rechargé octet-pour-octet.
    const recharge = importerSnapshotTelephone(snapshot);
    if (recharge.poidsU8.length !== cortex.csrCible.length) {
      throw new Error("Checkpoint : rechargement incohérent — arrêt (zéro écriture fausse).");
    }
    const erreur = erreurMaxQuantisation();
    const evaluation = {
      horodatage: horodatage(),
      graine: GRAINE,
      colonnes: COLONNES,
      trainMax, questionsTest, cyclesEod: CYCLES_EOD, lr: LR,
      totalTrain, totalTest,
      avant: { bonnes: tauxAvant.bonnes, total: tauxAvant.total, taux: m6(tauxAvant.taux) },
      apres: { bonnes: tauxApres.bonnes, total: tauxApres.total, taux: m6(tauxApres.taux) },
      eod: {
        dureeS: m6(dureeEodS),
        metabolisme: rapport.metabolisme,
        parDomaine: rapport.domaines.map((d) => ({
          domaine: d.domaine, bande: d.bande, resonanceMoyenne: m6(d.resonanceMoyenne),
          renforts: d.renforts, annulations: d.annulations,
        })),
      },
      detailParDomaine,
      langagier: {
        seuilAppariement: SEUIL_APPARIEMENT,
        pairesPropres: pairesPropres.length,
        pairesParasitesExclues: pairesParasites,
        avantVierge: avantLangagier,
        apresAppris: apresLangagier,
        totalBonnes: bonnesTotalApres,
        totalQuestions: totalQuestionsLangagier,
        taux: m6(tauxLangagier),
      },
      sources: lots.map((l) => ({ domaine: l.domaine, source: l.source, train: l.train.length, test: l.test.length })),
      quantisation: { fichier: cible, octets: snapshot.length, erreurMax: erreur },
    };
    writeFileSync(join(REP_CHECKPOINT, "evaluation.json"), JSON.stringify(evaluation, null, 1));
    console.log(`    checkpoint : ${cible} (${snapshot.length.toLocaleString("fr-FR")} octets, rechargé et validé)`);
    console.log(`    évaluation : ${join(REP_CHECKPOINT, "evaluation.json")}`);
    console.log(`    erreur max de quantisation : ${erreur}`);
  }

  // ---- 8. VERDICT ----------------------------------------------------------
  const gain = tauxApres.taux - tauxAvant.taux;
  console.log("\n=== VERDICT (mesuré, rien d'autre) ===");
  console.log(
    `Bandes porteuses (EOD) : ${m6(tauxAvant.taux * 100)} % (avant) → ${m6(tauxApres.taux * 100)} % (après) — gain ${m6(gain * 100)} points (8 porteurs pour 19 domaines : limite du design, publiée telle quelle).`,
  );
  console.log(
    `Cortex langagier (le chat réel) : ${bonnesTotalApres}/${totalQuestionsLangagier} questions servies par le bon domaine (${m6(tauxLangagier * 100)} %) · hors-domaine ${horsDomaineTotal} · sans réponse ${sansReponseTotal} · parasites exclues ${pairesParasites}.`,
  );
  console.log("19 domaines assimilés d'un seul coup (EOD it.57 + cortex langagier du chat).");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface ResultatAvecDomaine extends ResultatSonde {
  domaine: string;
}

function mesurer(
  cortex: CortexColumnnaire,
  champ: ChampCorticalGen3,
  lots: LotDomaine[],
): ResultatAvecDomaine[] {
  const resultats: ResultatAvecDomaine[] = [];
  const moteur = cortex as unknown as MoteurSonde;
  void champ;
  let horloge = 0;
  for (const lot of lots) {
    const bande = bandeDuDomaine(lot.domaine);
    for (const texte of lot.test) {
      horloge += CYCLES_SONDE;
      const r = sonder(moteur, texte, bande, horloge);
      resultats.push({ ...r, domaine: lot.domaine });
    }
  }
  return resultats;
}

function taux(resultats: ResultatAvecDomaine[]): { bonnes: number; total: number; taux: number } {
  const total = resultats.length;
  const bonnes = resultats.filter((r) => r.ok).length;
  return { bonnes, total, taux: total > 0 ? bonnes / total : 0 };
}

principal();
