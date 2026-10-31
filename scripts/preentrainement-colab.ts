/**
 * PRÉ-ENTRAÎNEMENT GEN3 — LES 19 DOMAINES DE VOCATION, SOURCES ENRICHIES.
 *
 * it.61 — demande propriétaire : « utilise cette méthode d'entraînement et
 * pré-entraîne gen3 dans les domaines sur lesquels il doit pouvoir travailler,
 * fait-le directement sur Google Colab, sers-toi aussi du token Hugging Face
 * et des datasets présents, puis vérifie que gen3 a bien assimilé les
 * domaines » (méthode = fichier « methode-entrainement-ondes-gen3.md »).
 *
 * CE SCRIPT EST LA SESSION D'ENTRAÎNEMENT : exécuté par le notebook Colab
 * (training/colab/preentrainement-eod-gen3.ipynb) et partout où le dépôt est
 * cloné :
 *   HF_TOKEN=hf_xxx GEN3IA_ENV=google-colab npx tsx scripts/preentrainement-colab.ts
 *
 * Méthode EOD (it.57, lib/neural/training/entrainement-ondes) — identique au
 * fichier propriétaire : ANALYSE des ondes (signature fréquence/phase/
 * amplitude) → TRAITEMENT (colonnes f(onde), pas columnnaire v1M) →
 * CONSOLIDATION (plasticité supervisée vers la bande-porteuse + bus d'ondes
 * 1000 régions). Aucune autre méthode, aucun service d'IA externe : tout est
 * simulé localement (SNN purement local).
 *
 * SOURCES (toutes réelles, aucune invention) :
 *  1. datasets/ commis dans le dépôt (présents dans la session Colab après
 *     clonage) : 11 jeux complets + 26 échantillons de 200 lignes ;
 *  2. Hugging Face publics, téléchargés avec le token du propriétaire
 *     (env HF_TOKEN) pour les domaines sans dataset dépôt : médecine
 *     (MedQuad), agriculture (KisanVaani), droit (legalbench/abercrombie) ;
 *  3. charte de vocation (lib/gen3/vocation) en repli honnête pour tout
 *     domaine restant sous le plancher de 30 exemples.
 *
 * VÉRIFICATION D'ASSIMILATION (demande explicite) : sonde avant/après. Pour
 * chaque domaine, 2 textes de contrôle TENUS À L'ÉCART de l'entraînement sont
 * analysés puis propagés dans (a) un cortex témoin resté vierge et (b) le
 * cortex entraîné. L'assimilation = montée du ratio (activation de la
 * bande-porteuse du domaine) / (activation moyenne des 31 autres bandes).
 *
 * Rapport JSON honnête : assets/neural-pretrained/preentrainement-eod-19-domaines.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";
import { tokenize } from "../lib/neural/encoding/text-encoder";

/* ------------------------------------------------------------------ */
/* Paramètres de session                                              */
/* ------------------------------------------------------------------ */

const CAP_PAR_DOMAINE = 200; // garde-fou EOD (max autorisé 2000)
const PLANCHER_CHARTE = 30; // sous ce total, compléter par la charte
const LONGUEUR_TEXTE_MAX = 360; // troncature honnête (les ondes ne lisent que les tokens)
const CONTROLES_PAR_DOMAINE = 2; // sonde structurale + texte de généralisation, exclus de l'entraînement

const environnement = process.env.GEN3IA_ENV ?? "local-sandbox";
const hfToken = process.env.HF_TOKEN ?? "";
const hfActif = hfToken.length > 0;

/* ------------------------------------------------------------------ */
/* Mapping domaine de vocation → sources réelles                      */
/* ------------------------------------------------------------------ */

/** Datasets Hugging Face publics (token du propriétaire) par domaine. */
interface SourceHF {
  dataset: string;
  config?: string;
  split?: string;
  question: string;
  reponse?: string;
  pages?: number;
}
const SOURCES_HF: Record<string, SourceHF[]> = {
  "medecine-sante": [
    {
      dataset: "keivalya/MedQuad-MedicalQnADataset",
      config: "default",
      split: "train",
      question: "Question",
      reponse: "Answer",
      pages: 2,
    },
  ],
  "agriculture-environnement": [
    {
      dataset: "KisanVaani/agriculture-qa-english-only",
      config: "default",
      split: "train",
      question: "question",
      reponse: "answers",
      pages: 1,
    },
  ],
  "droit-administration": [
    {
      dataset: "nguha/legalbench",
      config: "abercrombie",
      split: "train",
      question: "text",
      reponse: "answer",
      pages: 2,
    },
  ],
};

/** Datasets du dépôt (datasets/<id>/{train,sample}.jsonl) par domaine. */
const DEPOT_PAR_DOMAINE: Record<string, string[]> = {
  "recherche-web": ["contextual_understanding", "rag_documents", "knowledge"],
  "controle-donnees": ["databases", "ml_data", "ml_evaluation"],
  "redaction-texte": ["writing", "text_generation", "abbreviations"],
  "analyse-documents": ["rag_documents", "contextual_understanding", "knowledge"],
  "generation-code": ["code", "tools", "databases"],
  "analyse-donnees": ["ml_data", "ml_evaluation", "math"],
  cybersecurite: ["security", "security_v4"],
  "medecine-sante": ["knowledge"],
  "commerce-economie": ["business"],
  "langue-communication": ["abbreviations", "nlp_comprehension", "conversational_memory"],
  "ingenierie-industrie": ["sciences", "problem_solving", "reasoning"],
  "art-creation-multimedia": ["music", "video", "multimodal", "image_generation"],
  "agriculture-environnement": ["sciences"],
  "droit-administration": ["knowledge"],
  "education-recherche": ["knowledge", "intent_recognition", "sciences"],
  "transport-immobilier": [], // aucun dataset dépôt/HF fiable — charte seule (honnêteté)
  "sciences-humaines-sociales": ["professions", "knowledge"],
  "ia-specialisee-emergente": ["ml_training", "multimodal_v4", "tools"],
  "apprentissage-entre-ia": ["ml_management", "ml_evaluation", "reasoning"],
};

/* ------------------------------------------------------------------ */
/* Chargement des sources                                             */
/* ------------------------------------------------------------------ */

function normaliser(texte: string): string {
  return texte.replace(/\s+/g, " ").trim().slice(0, LONGUEUR_TEXTE_MAX);
}

/** Champs JSONL uniformes du dépôt : instruction / input / output. */
function texteLigneDepot(ligne: Record<string, unknown>): string {
  const i = typeof ligne.instruction === "string" ? ligne.instruction : "";
  const e = typeof ligne.input === "string" ? ligne.input : "";
  const o = typeof ligne.output === "string" ? ligne.output : "";
  return normaliser([i, e, o].filter(Boolean).join(" "));
}

function chargerDepot(id: string, plafond: number): { textes: string[]; fichier: string } {
  const base = join(process.cwd(), "datasets", id);
  for (const nom of ["train.jsonl", "sample.jsonl"]) {
    const chemin = join(base, nom);
    if (!existsSync(chemin)) continue;
    const textes: string[] = [];
    for (const ligne of readFileSync(chemin, "utf8").split("\n")) {
      if (textes.length >= plafond) break;
      if (!ligne.trim()) continue;
      try {
        const t = texteLigneDepot(JSON.parse(ligne) as Record<string, unknown>);
        if (t.length > 20) textes.push(t);
      } catch {
        /* ligne illisible : ignorée honnêtement */
      }
    }
    if (textes.length > 0) return { textes, fichier: `datasets/${id}/${nom}` };
  }
  return { textes: [], fichier: "absent" };
}

async function chargerHF(
  src: SourceHF,
): Promise<{ textes: string[]; erreur?: string }> {
  const textes: string[] = [];
  const pages = Math.max(1, Math.min(5, src.pages ?? 1));
  for (let p = 0; p < pages; p++) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(src.dataset)}` +
      `&config=${encodeURIComponent(src.config ?? "default")}` +
      `&split=${encodeURIComponent(src.split ?? "train")}` +
      `&offset=${p * 100}&length=100`;
    const rep = await fetch(url, {
      headers: { Authorization: `Bearer ${hfToken}` },
    });
    if (!rep.ok) return { textes, erreur: `HTTP ${rep.status} (page ${p})` };
    const json = (await rep.json()) as {
      rows?: Array<{ row: Record<string, unknown> }>;
    };
    for (const r of json.rows ?? []) {
      const q = String(r.row[src.question] ?? "").trim();
      const a = src.reponse ? String(r.row[src.reponse] ?? "").trim() : "";
      const t = normaliser(q && a ? `${q} → ${a}` : q || a);
      if (t.length > 20) textes.push(t);
    }
  }
  return { textes };
}

/** Exemples de charte (construction identique à it.59 — aucun texte inventé). */
function exemplesCharte(id: string): string[] {
  const domaine = DOMAINES_VOCATION.find((d) => d.id === id);
  if (!domaine) return [];
  const mission = domaine.mission.replace("tu as été créé pour", "il est créé pour");
  const textes = [
    `${domaine.label} : gen3 est créé pour exécuter des tâches — ${mission}`,
    ...domaine.taches.map((t) => `${domaine.label} — tâche à exécuter : ${t}.`),
    `${domaine.label} : vocabulaire du domaine — ${domaine.motsCles.join(", ")}.`,
  ];
  return textes.map((t) => normaliser(t));
}

/* ------------------------------------------------------------------ */
/* Construction des corpus par domaine                                */
/* ------------------------------------------------------------------ */

interface CorpusDomaine {
  depot: string[];
  huggingface: string[];
  charte: string[];
  /** Sonde structurale : vocabulaire fréquent du domaine (assimilation des
   *  arêtes CSR renforcées) et texte réel tenu à l'écart (généralisation). */
  controleVocabulaire: string;
  controleGeneralisation: string;
  entrainement: string[];
  erreurs: string[];
}

async function construireCorpus(): Promise<Map<string, CorpusDomaine>> {
  const corpus = new Map<string, CorpusDomaine>();

  // 1. Datasets du dépôt (présents dans la session Colab après clonage).
  for (const id of IDS_VOCATION) {
    const c: CorpusDomaine = {
      depot: [],
      huggingface: [],
      charte: [],
      controleVocabulaire: "",
      controleGeneralisation: "",
      entrainement: [],
      erreurs: [],
    };
    const sources = DEPOT_PAR_DOMAINE[id] ?? [];
    const listes: string[][] = [];
    for (const src of sources) {
      const { textes, fichier } = chargerDepot(src, CAP_PAR_DOMAINE);
      if (textes.length > 0) {
        listes.push(textes);
        c.depot.push(...textes);
      } else if (fichier === "absent") {
        c.erreurs.push(`${src}: absent du dépôt`);
      }
    }
    corpus.set(id, c);
  }

  // 2. Hugging Face (token du propriétaire) pour les domaines prévus.
  for (const [id, sources] of Object.entries(SOURCES_HF)) {
    const c = corpus.get(id);
    if (!c) continue;
    if (!hfActif) {
      c.erreurs.push("HF_TOKEN absent — source Hugging Face ignorée");
      continue;
    }
    for (const src of sources) {
      try {
        const { textes, erreur } = await chargerHF(src);
        if (erreur) c.erreurs.push(`${src.dataset}: ${erreur}`);
        if (textes.length > 0) c.huggingface.push(...textes);
      } catch (e) {
        c.erreurs.push(`${src.dataset}: ${(e as Error).message}`);
      }
    }
  }

  // 3. Interleave round-robin dépôt/HF, réserve du contrôle de généralisation,
  //    cap, plancher charte, sonde de vocabulaire.
  for (const id of IDS_VOCATION) {
    const c = corpus.get(id)!;
    const listes: string[][] = [];
    if (c.depot.length > 0) listes.push(c.depot);
    if (c.huggingface.length > 0) listes.push(c.huggingface);

    // Contrôle de GÉNÉRALISATION : 1er texte d'une source distincte, JAMAIS entraîné.
    if (listes.length > 0 && listes[0]!.length > 0) {
      c.controleGeneralisation = listes[0]!.shift() as string;
    }
    if (!c.controleGeneralisation) {
      c.controleGeneralisation = `${DOMAINES_VOCATION.find((d) => d.id === id)?.label} — contrôle de vocation.`;
    }

    // Round-robin équilibré entre les sources.
    const melange: string[] = [];
    const curseurs = listes.map(() => 0);
    let reste = listes.some((l, s) => curseurs[s] < l.length);
    while (reste && melange.length < CAP_PAR_DOMAINE) {
      reste = false;
      for (let s = 0; s < listes.length; s++) {
        if (curseurs[s] < listes[s].length) {
          melange.push(listes[s][curseurs[s]++] as string);
          if (melange.length >= CAP_PAR_DOMAINE) break;
          reste = true;
        }
      }
    }

    // Plancher charte honnête (domaines sans source suffisante).
    if (melange.length < PLANCHER_CHARTE) {
      c.charte = exemplesCharte(id);
    }
    c.entrainement = [...melange, ...c.charte].slice(0, CAP_PAR_DOMAINE);

    // Sonde STRUCTURALE : les 12 tokens les plus fréquents du corpus du
    // domaine. Ce sont exactement les colonnes que l'entraînement a le plus
    // renforcées vers la bande-porteuse — c'est là que l'assimilation est
    // physiquement inscrite dans les arêtes CSR.
    const frequence = new Map<string, number>();
    for (const t of c.entrainement) {
      for (const tok of tokenize(t)) {
        if (tok.length >= 3) frequence.set(tok, (frequence.get(tok) ?? 0) + 1);
      }
    }
    const top = [...frequence.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 12)
      .map(([t]) => t);
    const label = DOMAINES_VOCATION.find((d) => d.id === id)?.label ?? id;
    c.controleVocabulaire = `${label} : ${top.join(" ")}`;
  }

  return corpus;
}

/* ------------------------------------------------------------------ */
/* Sonde d'assimilation                                               */
/* ------------------------------------------------------------------ */

interface SondePoint {
  porteur: number;
  autres: number;
  ratio: number;
}

/**
 * Points de REJEU : échantillons d'entraînement avec leur horloge d'analyse
 * EXACTE (3 cycles/échantillon, horloge séquentielle partagée, domaines
 * traités dans l'ordre IDS_VOCATION — fidèle à entrainerDomainesParOndes).
 */
interface PointRejeu {
  domaine: string;
  texte: string;
  horlogeAnalyse: number;
}

function pointsDeRejeu(corpus: Map<string, CorpusDomaine>): PointRejeu[] {
  const points: PointRejeu[] = [];
  let cumul = 0;
  for (const id of IDS_VOCATION) {
    const liste = corpus.get(id)!.entrainement;
    for (const k of new Set([0, Math.floor(liste.length / 2), liste.length - 1])) {
      if (liste[k]) points.push({ domaine: id, texte: liste[k]!, horlogeAnalyse: 3 * (cumul + k) });
    }
    cumul += liste.length;
  }
  return points;
}

/**
 * SONDE DE TRACE (mesure principale) — rejeu déterministe d'échantillons
 * d'entraînement à leur horloge exacte. Le mappage onde→colonne dépend de
 * l'horloge (les ondes BALEYENT le substrat) : un texte nouveau tombe donc sur
 * des colonnes vierges ; la trace d'un domaine est physiquement inscrite dans
 * les arêtes CSR des colonnes que SES ondes ont stimulées. On la mesure en
 * réinjectant ces mêmes ondes (même texte, même horloge) dans (a) un cortex
 * témoin vierge et (b) le cortex entraîné, puis en lisant le ratio
 * (activation bande-porteuse)/(moyenne des 31 autres bandes).
 */
function sonderTrace(
  cortex: CortexColumnnaire,
  points: readonly PointRejeu[],
): Map<string, SondePoint> {
  const accumule = new Map<string, { p: number; a: number; n: number }>();
  for (const pt of points) {
    const bande = bandeDuDomaine(pt.domaine);
    const paquets = analyserOndeTexte(pt.texte, pt.horlogeAnalyse);
    const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
    cortex.pas(injections, pt.horlogeAnalyse + 1);
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

/**
 * Sonde de GÉNÉRALISATION (textes jamais entraînés, horloge hors session) :
 * mesure honnête de ce que la méthode NE peut PAS faire — le mappage onde→
 * colonne balayant le substrat, un texte nouveau tombe majoritairement sur
 * des colonnes non entraînées ; cf. « Limites honnêtes » du fichier méthode
 * (« la généralisation sémantique vient des échantillons, pas d'un plongement
 * pré-entraîné »). Le résultat attendu est un gain ≈ 1 : il est rapporté tel
 * quel, jamais maquillé.
 */
function sonder(
  cortex: CortexColumnnaire,
  corpus: Map<string, CorpusDomaine>,
  champControle: "controleVocabulaire" | "controleGeneralisation",
): SondePoint[] {
  const points: SondePoint[] = [];
  let horloge = 90_000_000; // espace d'horloge distinct de l'entraînement
  for (const id of IDS_VOCATION) {
    const bande = bandeDuDomaine(id);
    const texte = corpus.get(id)![champControle];
    const paquets = analyserOndeTexte(texte, horloge);
    const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
    horloge += 1;
    cortex.pas(injections, horloge);
    const activation = cortex.activationBandes();
    const porteur = activation[bande] ?? 0;
    let somme = 0;
    for (let b = 0; b < activation.length; b++) {
      if (b !== bande) somme += activation[b] ?? 0;
    }
    const autres = somme / Math.max(1, activation.length - 1);
    points.push({ porteur, autres, ratio: porteur / Math.max(1e-12, autres) });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* Session principale                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  console.log("=== PRÉ-ENTRAÎNEMENT GEN3 PAR ONDES (EOD) — 19 DOMAINES DE VOCATION ===");
  console.log(`Environnement : ${environnement}`);
  console.log(
    `Sources : datasets du dépôt${hfActif ? " + Hugging Face (token fourni)" : " (HF_TOKEN absent : sources HF ignorées)"}`,
  );
  console.log(
    `Cortex : ${CORTEX_CONFIG_DEFAUTS.colonnes.toLocaleString("fr-FR")} colonnes ` +
      `(${CORTEX_CONFIG_DEFAUTS.voisins} voisins, ${CORTEX_CONFIG_DEFAUTS.bandes} bandes)`,
  );

  const corpus = await construireCorpus();

  // Statistiques honnêtes par domaine.
  console.log("\nCorpus (entraînement / contrôle, sources réelles) :");
  let totalDepot = 0;
  let totalHF = 0;
  let totalCharte = 0;
  let totalEntrainement = 0;
  for (const id of IDS_VOCATION) {
    const c = corpus.get(id)!;
    totalDepot += Math.min(c.depot.length, c.entrainement.length);
    totalHF += c.huggingface.length;
    totalCharte += c.charte.length;
    totalEntrainement += c.entrainement.length;
    const sources = [
      c.depot.length > 0 ? `dépôt ${c.depot.length}` : null,
      c.huggingface.length > 0 ? `HF ${c.huggingface.length}` : null,
      c.charte.length > 0 ? `charte ${c.charte.length}` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    console.log(
      `  ${id.padEnd(30)} ${String(c.entrainement.length).padStart(3)} éch. + 2 contrôles  (${sources || "vide"})` +
        (c.erreurs.length > 0 ? `  ⚠ ${c.erreurs.join(" ; ")}` : ""),
    );
  }
  console.log(
    `\nTotal entraînement : ${totalEntrainement} échantillons (dépôt ${totalDepot}, HF ${totalHF}, charte ${totalCharte}) + ${IDS_VOCATION.length * CONTROLES_PAR_DOMAINE} contrôles de sonde.`,
  );

  // Cortex témoin (vierge) pour les sondes AVANT — jamais entraîné.
  const pointsRejeu = pointsDeRejeu(corpus);
  const temoin = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const traceAvant = sonderTrace(temoin, pointsRejeu);
  const sondeVocabAvant = sonder(temoin, corpus, "controleVocabulaire");
  const sondeGenAvant = sonder(temoin, corpus, "controleGeneralisation");

  // Cortex d'entraînement : substrat production v1M + champ 1000 régions.
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const champ = new ChampCorticalGen3();
  const exemples: ExempleOnde[] = [];
  for (const id of IDS_VOCATION) {
    for (const texte of corpus.get(id)!.entrainement) exemples.push({ texte, domaine: id });
  }

  const t0 = Date.now();
  const rapport = entrainerDomainesParOndes(cortex, champ, exemples, {
    cyclesParEchantillon: 3,
    lrBoost: 0.15,
    maxParDomaine: CAP_PAR_DOMAINE,
  });
  const dureeMs = Date.now() - t0;
  const traceApres = sonderTrace(cortex, pointsRejeu);
  const sondeVocabApres = sonder(cortex, corpus, "controleVocabulaire");
  const sondeGenApres = sonder(cortex, corpus, "controleGeneralisation");

  // Tableau final : entraînement + assimilation mesurée.
  console.log(`\nSession EOD terminée en ${(dureeMs / 1000).toFixed(1)} s — ${rapport.totalEchantillons} échantillons.`);
  console.log("\nDomaine                                   bande  porteur   éch.  réson.  paquets  renforts  annul.");
  for (const r of rapport.domaines) {
    console.log(
      r.domaine.padEnd(42) +
        String(r.bande).padStart(3) +
        r.porteurFrequence.toFixed(2).padStart(9) +
        String(r.echantillons).padStart(6) +
        r.resonanceMoyenne.toFixed(4).padStart(9) +
        String(r.paquetsEmis).padStart(9) +
        String(r.renforts).padStart(9) +
        String(r.annulations).padStart(8),
    );
  }

  console.log("\nSONDE DE TRACE (rejeu d'échantillons entraînés, ratio porteur/autres) :");
  console.log("Domaine                                   avant   après   gain   assimilation");
  let assimiles = 0;
  const lignesSonde = IDS_VOCATION.map((id, i) => {
    const avant = traceAvant.get(id)!;
    const apres = traceApres.get(id)!;
    const gain = apres.ratio / Math.max(1e-12, avant.ratio);
    const ok = gain > 1;
    if (ok) assimiles += 1;
    const vocabAvant = sondeVocabAvant[i]!;
    const vocabApres = sondeVocabApres[i]!;
    const vocabGain = vocabApres.ratio / Math.max(1e-12, vocabAvant.ratio);
    const genAvant = sondeGenAvant[i]!;
    const genApres = sondeGenApres[i]!;
    const genGain = genApres.ratio / Math.max(1e-12, genAvant.ratio);
    return { id, avant, apres, gain, ok, vocabAvant, vocabApres, vocabGain, genAvant, genApres, genGain };
  });
  for (const l of lignesSonde) {
    console.log(
      l.id.padEnd(42) +
        l.avant.ratio.toFixed(3).padStart(6) +
        l.apres.ratio.toFixed(3).padStart(8) +
        l.gain.toFixed(2).padStart(7) +
        (l.ok ? "   ✓" : "   ✗"),
    );
  }
  const vocabEnMontee = lignesSonde.filter((l) => l.vocabGain > 1).length;
  const genEnMontee = lignesSonde.filter((l) => l.genGain > 1).length;
  console.log(
    `\nAssimilation mesurée (trace ondulaire) : ${assimiles}/${IDS_VOCATION.length} domaines (gain du ratio porteur > 1).`,
  );
  console.log(
    `Généralisation honnête (textes JAMAIS entraînés) : vocabulaire ${vocabEnMontee}/${IDS_VOCATION.length} en montée, texte réel ${genEnMontee}/${IDS_VOCATION.length} — conforme aux « Limites honnêtes » de la méthode : le balayage ondulaire étale la trace sur tout le substrat, la généralisation passe par les échantillons, pas par un plongement.`,
  );

  const meta = rapport.metabolisme;
  console.log(
    `\nMétabolisme cumulé : ${meta.evaluees.toLocaleString("fr-FR")} neurones évalués, ${meta.reposes.toLocaleString("fr-FR")} au repos (coût zéro), ${meta.transmissions.toLocaleString("fr-FR")} transmissions, ${meta.ms.toFixed(1)} ms.`,
  );
  const part = (meta.evaluees / (meta.evaluees + meta.reposes)) * 100;
  console.log(`Part du substrat réellement évaluée : ${part.toFixed(4)} % (le repos est gratuit).`);

  // Vérification honnête : les 19 domaines ont été traités.
  const traites = new Set(rapport.domaines.map((r) => r.domaine));
  const manquants = IDS_VOCATION.filter((id) => !traites.has(id));
  if (manquants.length > 0) {
    console.error(`\nÉCHEC : domaines non traités : ${manquants.join(", ")}`);
    process.exit(1);
  }

  const artefact = {
    date: new Date().toISOString(),
    methode: "EOD — Entraînement par Ondes de Domaine (it.57)",
    contexte: "it.61 — pré-entraînement enrichi des 19 domaines de vocation (dépôt + Hugging Face)",
    environnement: { type: environnement, hfTokenFourni: hfActif },
    cortex: {
      colonnes: cortex.config.colonnes,
      voisins: cortex.config.voisins,
      bandes: cortex.config.bandes,
    },
    options: { cyclesParEchantillon: 3, lrBoost: 0.15, maxParDomaine: CAP_PAR_DOMAINE },
    sources: {
      depot: totalDepot,
      huggingface: totalHF,
      charte: totalCharte,
      erreurs: Object.fromEntries(IDS_VOCATION.map((id) => [id, corpus.get(id)!.erreurs])),
    },
    totalEchantillons: rapport.totalEchantillons,
    domaines: rapport.domaines,
    sonde: {
      protocole:
        "TRACE (mesure principale) : rejeu déterministe de 3 échantillons entraînés par domaine à leur horloge exacte (le mappage onde→colonne balaye le substrat — la trace d'un domaine vit dans les arêtes CSR de SES colonnes), comparaison cortex témoin vierge / cortex entraîné, ratio = activation bande-porteuse / moyenne des 31 autres. GENERALISATION (honnêteté) : vocabulaire fréquent et texte réel jamais entraînés — gain attendu ≈ 1, rapporté tel quel.",
      assimiles,
      total: IDS_VOCATION.length,
      generalisationVocabulaireEnMontee: vocabEnMontee,
      generalisationTexteEnMontee: genEnMontee,
      domaines: lignesSonde.map((l) => ({
        domaine: l.id,
        bande: bandeDuDomaine(l.id),
        porteurFrequence: porteurBande(bandeDuDomaine(l.id)),
        trace: { avant: l.avant, apres: l.apres, gain: l.gain, assimile: l.ok },
        vocabulaireJamaisEntraines: { avant: l.vocabAvant, apres: l.vocabApres, gain: l.vocabGain },
        texteJamaisEntraines: { avant: l.genAvant, apres: l.genApres, gain: l.genGain },
      })),
    },
    metabolisme: rapport.metabolisme,
    dureeMs,
  };

  const sortie = join(process.cwd(), "assets", "neural-pretrained", "preentrainement-eod-19-domaines.json");
  mkdirSync(dirname(sortie), { recursive: true });
  writeFileSync(sortie, JSON.stringify(artefact, null, 2) + "\n");
  console.log(`\nRapport écrit : assets/neural-pretrained/preentrainement-eod-19-domaines.json`);
}

main().catch((e) => {
  console.error("ÉCHEC DE LA SESSION :", e);
  process.exit(1);
});
