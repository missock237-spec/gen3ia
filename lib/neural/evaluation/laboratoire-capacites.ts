/**
 * LABORATOIRE D'ÉVALUATION INDÉPENDANT (LOT 7 — mission « GEN3IA BRAIN
 * COMPLETION »).
 *
 * BANC D'ESSAI INDÉPENDANT des tests des lots : les critères ci-dessous
 * sont réécrits séparément (nouveaux cas, nouvelles affirmations) pour
 * ne pas valider le cerveau avec ses propres miroirs. Chaque capacité
 * (sémantique, génération native, unification, raisonnement, mémoire,
 * multimodal) est mesurée sur des épreuves bornées → score 0..1 →
 * rapport persistant + recommandations d'optimisation DÉRIVÉES DES
 * MESURES (aucune suggestion inventée).
 *
 * Aucune API externe : tout s'exécute dans le process, médias synthétisés
 * localement (sharp pour l'image, WAV construit en mémoire, SMIL natif).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { analyserSemantique, comparerSemantique, similariteSemantique } from "../semantique/analyseur-semantique";
import { composerReponseNative, type FaitCompose } from "../generation/compositeur";
import { deduire, detecterContradictions, transitiviteIsa, type Fait, type Regle } from "../cognition/raisonnement-general";
import { MemoireCognitive } from "../cognition/memoire-cognitive";
import { boucleUnifiee, creerPortsReels } from "../unification/boucle-unifiee";
import { comprendreAudioWav, comprendreImage, comprendreVideoSmil } from "../multimodal/comprehension-multimodale";

/** Résultat d'une épreuve indépendante. */
export interface Epreuve {
  nom: string;
  reussie: boolean;
  /** Mesure brute (durée ms, score, etc.) — honnête. */
  mesure: string;
}

/** Résultat d'une capacité. */
export interface CapaciteEvaluee {
  capacite: string;
  score: number; // 0..1
  epreuves: Epreuve[];
  dureeMs: number;
}

/** Rapport complet du laboratoire. */
export interface RapportLaboratoire {
  dateIso: string;
  capacites: CapaciteEvaluee[];
  /** Score global = moyenne pondérée égale des capacités (0..1). */
  scoreGlobal: number;
  dureeTotaleMs: number;
  /** Recommandations dérivées des mesures (bornées, typées). */
  optimisations: Array<{ cible: string; constat: string; suggestion: string }>;
}

/* ─────────── ÉPREUVES SÉMANTIQUES (indépendantes) ─────────── */
function epreuvesSemantiques(): Epreuve[] {
  const e: Epreuve[] = [];
  // 1) Paraphrases sans mots communs (lexique nécessaire).
  const p1 = comparerSemantique("acheter une voiture d'occasion", "acquérir un véhicule usagé");
  e.push({ nom: "paraphrase-synonymique", reussie: p1.score >= 0.45, mesure: `score=${p1.score} groupes=${p1.groupesSynonymesPartages}` });
  // 2) Négation opposée : sens inversé, score rabattu.
  const p2 = comparerSemantique("le moteur fonctionne", "le moteur ne fonctionne pas");
  e.push({ nom: "negation-opposee", reussie: p2.negationOpposee && p2.score <= 0.35, mesure: `score=${p2.score}` });
  // 3) Identité quasi parfaite.
  const p3 = similariteSemantique("la gravité attire les corps massifs", "la gravité attire les corps massifs");
  e.push({ nom: "identite", reussie: p3 >= 0.95, mesure: `score=${p3}` });
  // 4) Typage de question complet (9 types du LOT 2, vérifiés ici).
  const questions = ["Pourquoi ?", "Comment ?", "Combien ?", "Qui ?", "Qu'est-ce que ?", "Quand ?", "Où ?", "Explique", "Liste"];
  const types = new Set(questions.map((q) => analyserSemantique(q).question));
  e.push({ nom: "typage-questions", reussie: types.size >= 8, mesure: `types=${types.size}` });
  return e;
}

/* ─────────── ÉPREUVES GÉNÉRATION NATIVE (indépendantes) ─────────── */
function epreuvesGeneration(): Epreuve[] {
  const e: Epreuve[] = [];
  const faits: FaitCompose[] = [
    { cle: "b1", valeur: "elle convertit la lumière en sucre" },
    { cle: "b2", valeur: "elle se déroule dans les chloroplastes" },
    { cle: "b3", valeur: "elle libère de l'oxygène" },
  ];
  const r = composerReponseNative({ question: "Qu'est-ce que la photosynthèse ?", concept: "photosynthèse", faits, resume: "un processus biologique des plantes" });
  const nonVerbatim = r !== null && !faits.some((f) => r.texte.trim() === f.valeur.trim());
  e.push({ nom: "non-verbatim", reussie: nonVerbatim, mesure: r ? `longueur=${r.texte.length}` : "refus" });
  const fidelite = r !== null && faits.slice(0, 2).every((f) => r.texte.toLowerCase().includes(f.valeur.toLowerCase().slice(0, 20)));
  e.push({ nom: "fidelite-aux-faits", reussie: fidelite, mesure: r ? `patron=${r.patron}` : "refus" });
  const refuse = composerReponseNative({ question: "Qu'est-ce que la lévitation ?", concept: "lévitation", faits: [] }) === null;
  e.push({ nom: "refus-sans-faits", reussie: refuse, mesure: "null attendu" });
  return e;
}

/* ─────────── ÉPREUVES RAISONNEMENT (indépendantes) ─────────── */
function epreuvesRaisonnement(): Epreuve[] {
  const e: Epreuve[] = [];
  const regles: Regle[] = [
    { si: { predicat: "vivre dans", objet: "eau" }, alors: { predicat: "est un", objet: "aquatique" } },
    { si: { predicat: "est un", objet: "aquatique" }, alors: { predicat: "nage", objet: "milieu-liquide" } },
  ];
  const faits: Fait[] = [
    { sujet: "le dauphin", predicat: "vivre dans", objet: "eau", source: "bench" },
    { sujet: "la pièce", predicat: "est", objet: "chaud", source: "bench" },
    { sujet: "la pièce", predicat: "est", objet: "froid", source: "bench-faux" },
  ];
  const conclusions = deduire(faits, regles);
  const chaine2 = conclusions.some((c) => c.fait.predicat === "nage" && c.profondeur === 2 && c.preuves.length >= 1);
  e.push({ nom: "chainage-2-niveaux", reussie: chaine2, mesure: `conclusions=${conclusions.length}` });
  const isa = transitiviteIsa([{ sujet: "le chien", predicat: "est un", objet: "canide", source: "bench" }]);
  e.push({ nom: "transitivite-isa", reussie: isa.some((c) => c.fait.objet === "animal"), mesure: `isa=${isa.length}` });
  const contrad = detecterContradictions(faits);
  e.push({ nom: "contradiction-antonymique", reussie: contrad.length === 1, mesure: `contradictions=${contrad.length}` });
  return e;
}

/* ─────────── ÉPREUVES MÉMOIRE (indépendantes) ─────────── */
function epreuvesMemoire(dossier: string): Epreuve[] {
  const e: Epreuve[] = [];
  const m = new MemoireCognitive(dossier);
  m.enregistrer({ type: "interaction", contenu: "L'utilisateur demande l'état du pipeline de connaissances autonomes", importance: 0.9 });
  m.enregistrer({ type: "reflexion", contenu: "Vérification des licences des sources d'acquisition", importance: 0.4 });
  const rappels = m.rappeler("pipeline de connaissances", 2);
  e.push({ nom: "rappel-associatif", reussie: rappels.length > 0 && rappels[0].contenu.includes("pipeline"), mesure: `rappels=${rappels.length}` });
  m.persister();
  const m2 = new MemoireCognitive(dossier);
  e.push({ nom: "persistance", reussie: m2.taille() === m.taille(), mesure: `tailles=${m.taille()}/${m2.taille()}` });
  const borne = m2.enregistrer({ type: "reflexion", contenu: "essai de borne", importance: 9 });
  e.push({ nom: "bornes-importance", reussie: borne.importance === 1 && borne.contenu.length <= 2_000, mesure: `importance=${borne.importance}` });
  return e;
}

/* ─────────── ÉPREUVES UNIFICATION (composants réels) ─────────── */
async function epreuvesUnification(): Promise<Epreuve[]> {
  const e: Epreuve[] = [];
  const ports = await creerPortsReels({ nbNoeudsRPIA: 32 });
  // Marque unique par exécution : le cortex est un singleton vivant —
  // un second banc sur les mêmes questions ne doit PAS dupliquer
  // (idempotence). Le bench mesure donc des connaissances INÉDITES.
  const marque = `${Date.now()}`;
  const connaissances = [
    { question: `Qu'est-ce que le vent numéro ${marque} ?`, reponse: `Le vent ${marque} est un déplacement d'air entre zones de pression différentes`, label: "sciences" },
    { question: `Qu'est-ce qu'une cellule numéro ${marque} ?`, reponse: `La cellule ${marque} est l'unité de base des êtres vivants`, label: "sciences" },
  ];
  const sondes = [
    { question: `Qu'est-ce que le vent numéro ${marque} ?`, attendu: "déplacement air pression" },
    { question: `Qu'est-ce qu'une cellule numéro ${marque} ?`, attendu: "unité base vivants" },
  ];
  const r = await boucleUnifiee(connaissances, ports, sondes, { epochsSnn: 1, epoquesRPIA: 15 });
  e.push({ nom: "paires-reelles", reussie: r.langage.pairesAjoutees === 2, mesure: `ajoutees=${r.langage.pairesAjoutees}` });
  e.push({ nom: "snn-mesure", reussie: Number.isFinite(r.snn.accuracyTrain) && r.snn.echantillons === 2, mesure: `accTrain=${r.snn.accuracyTrain}` });
  e.push({ nom: "rpia-discriminabilite", reussie: r.rpia.discriminabilite !== null && r.rpia.discriminabilite >= 0, mesure: `disc=${r.rpia.discriminabilite}` });
  return e;
}

/* ─────────── ÉPREUVES MULTIMODAL (médias synthétiques réels) ─────────── */
async function epreuvesMultimodal(): Promise<Epreuve[]> {
  const e: Epreuve[] = [];
  // Image réelle synthétisée par sharp.
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 200, g: 30, b: 40 } } }).png().toBuffer();
  const img = await comprendreImage(png);
  e.push({ nom: "image-comprise", reussie: img.comprise && img.interpretation.length > 0 && img.couleurDominante.rouge > 100, mesure: `lum=${img.luminanceMoyenne} dom=${img.couleurDominante.rouge}` });
  // WAV tonal réel construit en mémoire.
  const sr = 8_000;
  const n = 1_600;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(20_000 * Math.sin(2 * Math.PI * 300 * i / sr)), 44 + i * 2);
  const audio = comprendreAudioWav(wav);
  e.push({ nom: "audio-tonal", reussie: audio.classe === "tonal" && audio.rms > 0.3, mesure: `rms=${audio.rms} centre=${audio.centreSpectralHz}Hz` });
  // SMIL compris + mp4 refusé.
  const smil = `<svg><rect width="10" height="10"><animate attributeName="x" dur="2s"/></rect><circle r="4"/></svg>`;
  const video = comprendreVideoSmil(smil);
  e.push({ nom: "video-smil", reussie: video.comprise && video.nbAnimations === 1 && video.dureeSecondes === 2, mesure: `anim=${video.nbAnimations}` });
  let refus = false;
  try {
    comprendreVideoSmil(Buffer.from("\u0000\u0000ftypisom"));
  } catch {
    refus = true;
  }
  e.push({ nom: "refus-honnete-mp4", reussie: refus, mesure: "throw attendu" });
  return e;
}

/** LANCE le banc complet et produit le rapport persistant. */
export async function evaluerCerveau(dossierRapports?: string, dossierMemoire?: string): Promise<RapportLaboratoire> {
  const debut = Date.now();
  const capacites: CapaciteEvaluee[] = [];

  const construire = (nom: string, epreuves: Epreuve[], dureeMs: number): CapaciteEvaluee => ({
    capacite: nom,
    score: epreuves.length > 0 ? Math.round((epreuves.filter((x) => x.reussie).length / epreuves.length) * 1000) / 1000 : 0,
    epreuves,
    dureeMs,
  });

  const tSem = Date.now();
  capacites.push(construire("semantique", epreuvesSemantiques(), Date.now() - tSem));
  const tGen = Date.now();
  capacites.push(construire("generation-native", epreuvesGeneration(), Date.now() - tGen));
  const tRai = Date.now();
  capacites.push(construire("raisonnement", epreuvesRaisonnement(), Date.now() - tRai));
  const tMem = Date.now();
  capacites.push(construire("memoire", epreuvesMemoire(dossierMemoire ?? "var/neural/evaluation/memoire-bench"), Date.now() - tMem));
  const tUni = Date.now();
  capacites.push(construire("unification", await epreuvesUnification(), Date.now() - tUni));
  const tMul = Date.now();
  capacites.push(construire("multimodal", await epreuvesMultimodal(), Date.now() - tMul));

  const scoreGlobal = Math.round((capacites.reduce((s, c) => s + c.score, 0) / capacites.length) * 1000) / 1000;

  // OPTIMISATIONS dérivées UNIQUEMENT des mesures (aucune suggestion libre).
  const optimisations: RapportLaboratoire["optimisations"] = [];
  for (const c of capacites) {
    if (c.score < 1) {
      const echecs = c.epreuves.filter((x) => !x.reussie).map((x) => x.nom);
      optimisations.push({
        cible: c.capacite,
        constat: `score ${c.score} — épreuves en échec : ${echecs.join(", ")}`,
        suggestion: `augmenter la couverture de la capacité ${c.capacite} (données/relations manquantes détectées par les épreuves échouées)`,
      });
    }
    if (c.dureeMs > 5_000) {
      optimisations.push({
        cible: c.capacite,
        constat: `durée ${c.dureeMs} ms > budget 5 000 ms`,
        suggestion: "réduire les bornes de la passe (échantillons/époques) — RAM 2 cœurs",
      });
    }
  }

  const rapport: RapportLaboratoire = {
    dateIso: new Date().toISOString(),
    capacites,
    scoreGlobal,
    dureeTotaleMs: Date.now() - debut,
    optimisations,
  };

  if (dossierRapports) {
    mkdirSync(dossierRapports, { recursive: true });
    const nom = `capacites-${rapport.dateIso.replace(/[:.]/gu, "-")}.json`;
    writeFileSync(join(dossierRapports, nom), JSON.stringify(rapport, null, 1), "utf8");
    writeFileSync(join(dossierRapports, "dernier-rapport.json"), JSON.stringify(rapport, null, 1), "utf8");
  }
  return rapport;
}
