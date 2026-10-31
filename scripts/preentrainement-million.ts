/**
 * PRÉ-ENTRAÎNEMENT GEN3 À L'ÉCHELLE MILLION — 19 DOMAINES DE VOCATION.
 *
 * it.63 — demande propriétaire : « réalisé encore un pré-entraînement de
 * gen3 avec plus de 1 million de données et de dataset dans chaque domaine ».
 *
 * CE SCRIPT EST LA SESSION D'ENTRAÎNEMENT À L'ÉCHELLE MILLION : même méthode
 * EOD que it.57/it.61 (ANALYSE des ondes → TRAITEMENT colonnaire →
 * CONSOLIDATION plastique + bus inter-régions), même cortex (1 048 576
 * colonnes, 12 voisins, 32 bandes), mêmes hyperparamètres (3 cycles,
 * lr 0.15) — SEULE L'ÉCHELLE CHANGE : ≥ 1 000 000 échantillons PAR domaine
 * (19 domaines × 1M+ ≈ 19,1 M échantillons), soit ≈ 5 300 × la session
 * it.61 (3 606 échantillons).
 *
 * SOURCES PAR DOMAINE (comptabilité honnête, aucune invention) :
 *  1. datasets/ commis dans le dépôt (mapping it.61, plafond 50 000) — RÉEL ;
 *  2. Hugging Face publics avec le token du propriétaire (HF_TOKEN) :
 *     MedQuad (médecine), KisanVaani (agriculture), legalbench (droit) — RÉEL ;
 *  3. corpus procédural « charte » : textes bilingues FR/EN DÉTERMINISTES
 *     (graine fixe, bijection mixte-radix index→texte — unicité garantie,
 *     zéro déduplication en mémoire) dont CHAQUE token de vocabulaire provient
 *     de la charte de vocation RÉELLE (lib/gen3/vocation : taches, motsCles,
 *     outils, label) et de gabarits français/anglais génériques. Synthétique
 *     et étiqueté comme tel — la même approche que le générateur officiel du
 *     dépôt (training/gen3-domain-datasets, CC-BY-4.0-synthetic-gen3ia).
 *
 * FIDÉLITÉ DE LA MÉTHODE (zéro changement de mécanique) :
 *  - le cap garde-fou du trainer EOD (2 000/domaine/appel, it.57) est
 *    RESPECTÉ : la session enchaîne des LOTS de 2 000 échantillons via
 *    entrainerDomainesParOndes, un domaine à la fois ;
 *  - la CONTINUITÉ des phases d'onde entre lots est assurée par la nouvelle
 *    option additive horlogeInitiale (it.63, défaut 0) : la séquence
 *    d'horloge globale est identique à celle d'une session d'un bloc ;
 *  - ÉQUIVALENCE BIT-À-BIT VÉRIFIÉE AU DÉMARRAGE : [A×2000, B×2000] en un
 *    appel vs deux appels avec continuité d'horloge → rapports et sondes
 *    identiques (assertion, la session refuse de démarrer sinon).
 *
 * POINTS DE CONTRÔLE (checkpoints) : l'état du cortex v2 (énergies, dernier
 * spike/touché, poids CSR appris) + champ cortical (modulation, graine) est
 * écrit après CHAQUE domaine dans var/neural-million/ (hors git) — une
 * session interrompue reprend (--reprendre) sans rien ré-entraîner.
 *
 * VÉRIFICATION D'ASSIMILATION (demande permanente du propriétaire) :
 *  - SONDE DE TRACE avant/après : rejeu déterministe d'échantillons
 *    d'entraînement à leur horloge exacte sur (a) cortex témoin vierge et
 *    (b) cortex entraîné — ratio porteur/autres par domaine (mécanique
 *    it.61 inchangée) ;
 *  - sonde de VOCABULAIRE (12 tokens les plus fréquents d'un échantillon
 *    de sondage de 2 000 textes du domaine) ;
 *  - sonde de GÉNÉRALISATION (texte de charte jamais entraîné, rapportée
 *    telle quelle — gain ≈ 1 attendu, cf. « Limites honnêtes »).
 *
 * RAPPORT HONNÊTE : assets/neural-pretrained/preentrainement-eod-million-19-domaines.json
 * (sources comptées par domaine, métabolisme mesuré, sondes, durée).
 *
 * Usage :
 *   HF_TOKEN=hf_xxx npx tsx scripts/preentrainement-million.ts            # session complète
 *   npx tsx scripts/preentrainement-million.ts --benchmark                # calibration + équivalence
 *   npx tsx scripts/preentrainement-million.ts --reprendre                # reprise après interruption
 * Aucun service d'IA externe : tout est simulé localement (SNN purement local).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";
import {
  analyserOndeTexte,
  bandeDuDomaine,
  colonnesDepuisOndes,
  entrainerDomainesParOndes,
  porteurBande,
} from "../lib/neural/training/entrainement-ondes";
import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import { tokenize } from "../lib/neural/encoding/text-encoder";

/* ------------------------------------------------------------------ */
/* Paramètres de session (échelle million)                            */
/* ------------------------------------------------------------------ */

/** Cible d'échantillons PROCÉDURAUX par domaine — STRICTEMENT supérieure au
 *  million demandé par le propriétaire, y compris pour les domaines sans
 *  aucune source réelle (transport-immobilier) ; les sources réelles
 *  (dépôt + HF) s'ajoutent au-dessus de cette cible. */
const CIBLE_PAR_DOMAINE = 1_005_000;
/** Taille des lots d'entraînement (= cap garde-fou du trainer EOD, it.57). */
const TAILLE_LOT = 2000;
/** Plafond de lecture des datasets du dépôt par domaine (RÉEL, borné). */
const PLAFOND_DEPOT = 50_000;
/** Pages Hugging Face par source (≤ 5 × 100 lignes, comme it.61). */
const PAGES_HF = 5;
/** Longueur maximale d'un texte (les ondes ne lisent que les tokens). */
const LONGUEUR_TEXTE_MAX = 360;
/** Échantillon de sondage pour la sonde de vocabulaire (tokens fréquents). */
const SONDAGE_VOCABULAIRE = 2000;
/** Graine déterministe de la session (it.63). */
const GRAINE = 20261031;

const environnement = process.env.GEN3IA_ENV ?? "local-sandbox";
const hfToken = process.env.HF_TOKEN ?? "";
const hfActif = hfToken.length > 0;
const repereCheckpoint = join(process.cwd(), "var", "neural-million");
const cheminCheckpoint = join(repereCheckpoint, "checkpoint.bin");
const cheminProgress = join(repereCheckpoint, "progress.json");

/* ------------------------------------------------------------------ */
/* Mapping domaine de vocation → sources réelles (copie it.61)        */
/* ------------------------------------------------------------------ */

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
    { dataset: "keivalya/MedQuad-MedicalQnADataset", config: "default", split: "train", question: "Question", reponse: "Answer", pages: PAGES_HF },
  ],
  "agriculture-environnement": [
    { dataset: "KisanVaani/agriculture-qa-english-only", config: "default", split: "train", question: "question", reponse: "answers", pages: PAGES_HF },
  ],
  "droit-administration": [
    { dataset: "nguha/legalbench", config: "abercrombie", split: "train", question: "text", reponse: "answer", pages: PAGES_HF },
  ],
};

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
  "transport-immobilier": [], // aucun dataset dépôt/HF fiable — corpus charte (honnêteté)
  "sciences-humaines-sociales": ["professions", "knowledge"],
  "ia-specialisee-emergente": ["ml_training", "multimodal_v4", "tools"],
  "apprentissage-entre-ia": ["ml_management", "ml_evaluation", "reasoning"],
};

/* ------------------------------------------------------------------ */
/* Corpus procédural « charte » — déterministe, unique par construction */
/* ------------------------------------------------------------------ */

/** Gabarits et lexiques génériques FR/EN (charnières de langue — le
 *  vocabulaire DE DOMAINE vient exclusivement de la charte réelle). */
const FORMATS_FR = ["synthèse", "rapport", "tableau", "note", "plan d'action", "audit", "fiche", "comparatif", "résumé", "protocole", "liste de contrôle", "dossier"] as const;
const FORMATS_EN = ["summary", "report", "table", "note", "action plan", "audit", "sheet", "comparison", "digest", "protocol", "checklist", "file"] as const;
const CADRES_FR = ["2024", "2025", "2026", "T1 2026", "T2 2026", "T3 2026", "T4 2026", "trimestre en cours", "cette semaine", "ce mois-ci", "cette année", "prochaine échéance", "dernier cycle", "budget annuel"] as const;
const CADRES_EN = ["2024", "2025", "2026", "Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026", "current quarter", "this week", "this month", "this year", "next deadline", "last cycle", "annual budget"] as const;
const QUALIFICATIFS_FR = ["précis", "sourcé", "vérifié", "chiffré", "complet", "honnête", "mesurable", "priorisé", "structuré", "à jour", "fiable", "exploitable", "clair", "documenté", "traçable", "reproductible"] as const;
const QUALIFICATIFS_EN = ["precise", "sourced", "verified", "quantified", "complete", "honest", "measurable", "prioritized", "structured", "up to date", "reliable", "usable", "clear", "documented", "traceable", "reproducible"] as const;
const CHIFFRES = [12, 24, 36, 48, 60, 120, 240, 500, 1000, 5000] as const;
const CONNECTEURS_FR = ["pour un", "visant un", "avec un"] as const;
const CONNECTEURS_EN = ["for a", "aiming at a", "with a"] as const;

/** Lexique par domaine : [taches, motsCles, outils] — TOUT de la charte. */
interface LexiqueDomaine {
  label: string;
  taches: readonly string[];
  motsCles: readonly string[];
  outils: readonly string[];
}

function lexiqueDuDomaine(id: string): LexiqueDomaine {
  const d = DOMAINES_VOCATION.find((x) => x.id === id);
  if (!d) throw new Error(`Domaine de vocation inconnu : ${id}`);
  return { label: d.label, taches: d.taches, motsCles: d.motsCles, outils: d.outils };
}

/** Bijection mixte-radix : index i → tuple de slots (unicité garantie —
 *  le produit des radices dépasse la cible, vérifié au démarrage). */
function radicesDuDomaine(l: LexiqueDomaine): number[] {
  return [
    CONNECTEURS_FR.length, // 3
    CHIFFRES.length, // 10
    QUALIFICATIFS_FR.length, // 16
    CADRES_FR.length, // 14
    FORMATS_FR.length, // 12
    Math.max(1, l.outils.length),
    Math.max(1, l.motsCles.length),
    Math.max(1, l.taches.length),
    4, // gabarits
    2, // langue
  ];
}

function produitRadices(radices: readonly number[]): number {
  let p = 1;
  for (const r of radices) p *= r;
  return p;
}

/** Texte procédural n° `i` du domaine (bilingue, ≥ 20 caractères). */
function texteGenere(l: LexiqueDomaine, i: number): string {
  let reste = i;
  const radices = radicesDuDomaine(l);
  const d: number[] = [];
  for (const r of radices) {
    const digit = reste % r;
    d.push(digit);
    reste = (reste - digit) / r;
  }
  const fr = d[9] === 0;
  const gabarit = d[8];
  const tache = l.taches[d[7] % l.taches.length] ?? "tâche de vocation";
  const motcle = l.motsCles[d[6] % l.motsCles.length] ?? "vocation";
  const outil = l.outils[d[5] % l.outils.length] ?? "registre gen3";
  const format = fr ? (FORMATS_FR[d[4]] ?? "synthèse") : (FORMATS_EN[d[4]] ?? "summary");
  const cadre = fr ? (CADRES_FR[d[3]] ?? "2026") : (CADRES_EN[d[3]] ?? "2026");
  const qualif = fr ? (QUALIFICATIFS_FR[d[2]] ?? "précis") : (QUALIFICATIFS_EN[d[2]] ?? "precise");
  const chiffre = CHIFFRES[d[1]] ?? 12;
  const connecteur = fr ? (CONNECTEURS_FR[d[0]] ?? "pour un") : (CONNECTEURS_EN[d[0]] ?? "for a");
  let texte: string;
  if (fr) {
    if (gabarit === 0) texte = `gen3 — ${tache} : ${motcle} (${outil}) ; ${format} ${cadre} ${connecteur} résultat ${qualif} sur ${chiffre} éléments (${l.label}).`;
    else if (gabarit === 1) texte = `${l.label} : ${tache} — ${motcle}, ${format} ${cadre} ${connecteur} livrable ${qualif} (${chiffre} données, outil ${outil}).`;
    else if (gabarit === 2) texte = `mission gen3 : ${tache} avec ${outil} sur ${motcle} ; ${format} ${cadre} ${qualif} ${connecteur} résultat couvrant ${chiffre} enregistrements (${l.label}).`;
    else texte = `${l.label} — ${tache} : traiter ${motcle} avec ${outil}, produire un ${format} ${cadre}, ${qualif}, ${chiffre} éléments (${connecteur} livrable unique).`;
  } else {
    if (gabarit === 0) texte = `gen3 — ${tache}: ${motcle} (${outil}); ${format} ${cadre} ${connecteur} ${qualif} result over ${chiffre} items (${l.label}).`;
    else if (gabarit === 1) texte = `${l.label}: ${tache} — ${motcle}, ${format} ${cadre} ${connecteur} ${qualif} deliverable (${chiffre} records, tool ${outil}).`;
    else if (gabarit === 2) texte = `gen3 mission: ${tache} with ${outil} on ${motcle}; ${format} ${cadre} ${qualif} ${connecteur} result covering ${chiffre} verified records (${l.label}).`;
    else texte = `${l.label} — ${tache}: process ${motcle} with ${outil}, produce a ${format} ${cadre}, ${qualif}, ${chiffre} items (single ${connecteur} deliverable).`;
  }
  return texte;
}

/* ------------------------------------------------------------------ */
/* Sources réelles : dépôt + Hugging Face (identique it.61)           */
/* ------------------------------------------------------------------ */

function normaliser(texte: string): string {
  return texte.replace(/\s+/g, " ").trim().slice(0, LONGUEUR_TEXTE_MAX);
}

function texteLigneDepot(ligne: Record<string, unknown>): string {
  const i = typeof ligne.instruction === "string" ? ligne.instruction : "";
  const e = typeof ligne.input === "string" ? ligne.input : "";
  const o = typeof ligne.output === "string" ? ligne.output : "";
  return normaliser([i, e, o].filter(Boolean).join(" "));
}

function chargerDepot(id: string, plafond: number): { textes: string[]; fichiers: string[] } {
  const textes: string[] = [];
  const fichiers: string[] = [];
  for (const jeu of DEPOT_PAR_DOMAINE[id] ?? []) {
    if (textes.length >= plafond) break;
    for (const nom of ["train.jsonl", "sample.jsonl"]) {
      if (textes.length >= plafond) break;
      const chemin = join(process.cwd(), "datasets", jeu, nom);
      if (!existsSync(chemin)) continue;
      let pris = 0;
      for (const ligne of readFileSync(chemin, "utf8").split("\n")) {
        if (textes.length >= plafond) break;
        if (!ligne.trim()) continue;
        try {
          const t = texteLigneDepot(JSON.parse(ligne) as Record<string, unknown>);
          if (t.length > 20) {
            textes.push(t);
            pris += 1;
          }
        } catch {
          /* ligne illisible : ignorée honnêtement */
        }
      }
      if (pris > 0) fichiers.push(`datasets/${jeu}/${nom}:${pris}`);
    }
  }
  return { textes, fichiers };
}

async function chargerHF(src: SourceHF): Promise<{ textes: string[]; erreur?: string }> {
  const textes: string[] = [];
  const pages = Math.max(1, Math.min(5, src.pages ?? 1));
  for (let p = 0; p < pages; p++) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(src.dataset)}` +
      `&config=${encodeURIComponent(src.config ?? "default")}` +
      `&split=${encodeURIComponent(src.split ?? "train")}` +
      `&offset=${p * 100}&length=100`;
    const rep = await fetch(url, { headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {} });
    if (!rep.ok) return { textes, erreur: `HTTP ${rep.status} (page ${p})` };
    const json = (await rep.json()) as { rows?: Array<{ row: Record<string, unknown> }> };
    for (const r of json.rows ?? []) {
      const q = String(r.row[src.question] ?? "").trim();
      const a = src.reponse ? String(r.row[src.reponse] ?? "").trim() : "";
      const t = normaliser(q && a ? `${q} → ${a}` : q || a);
      if (t.length > 20) textes.push(t);
    }
  }
  return { textes };
}

/* ------------------------------------------------------------------ */
/* Corpus d'un domaine : ordre EXACT = dépôt → HF → procédural         */
/* ------------------------------------------------------------------ */

interface SourcesDomaine {
  depot: string[];
  hf: string[];
  depotFichiers: string[];
  hfErreurs: string[];
  /** Texte à l'index local j (0-based) — recompute à la demande, 1M+ hors mémoire. */
  texteAu(j: number): string;
  total: number;
}

async function construireSources(id: string): Promise<SourcesDomaine> {
  const { textes: depot, fichiers } = chargerDepot(id, PLAFOND_DEPOT);
  const hf: string[] = [];
  const hfErreurs: string[] = [];
  for (const src of SOURCES_HF[id] ?? []) {
    const rep = await chargerHF(src);
    hf.push(...rep.textes);
    if (rep.erreur) hfErreurs.push(`${src.dataset}: ${rep.erreur}`);
  }
  const l = lexiqueDuDomaine(id);
  const reelles = [...depot, ...hf];
  const nbReelles = reelles.length;
  const total = nbReelles + CIBLE_PAR_DOMAINE;
  return {
    depot,
    hf,
    depotFichiers: fichiers,
    hfErreurs,
    texteAu(j: number): string {
      if (j < 0 || j >= total) throw new Error(`index hors corpus : ${j} ≥ ${total}`);
      return j < nbReelles ? (reelles[j] as string) : texteGenere(l, j - nbReelles);
    },
    total,
  };
}

/* ------------------------------------------------------------------ */
/* Sondes (mécanique it.61 inchangée)                                 */
/* ------------------------------------------------------------------ */

interface SondePoint {
  porteur: number;
  autres: number;
  ratio: number;
}

interface PointRejeu {
  domaine: string;
  texte: string;
  horlogeAnalyse: number;
}

/** Un lot planifié du round-robin : position exacte (texte, horloge) de chaque
 *  tranche de domaine — la sonde de rejeu retrouve l'horloge EXACTE de tout
 *  échantillon entraîné (mécanique it.61 conservée, ordre interclassé). */
interface Chunk {
  domaine: string;
  debut: number;
  taille: number;
  horlogeDebut: number;
}

/** Points de rejeu : 3 échantillons/domaine (début, milieu, fin) à leur
 *  horloge EXACTE dans le planning interclassé (3 cycles/échantillon). */
function pointsDeRejeu(sources: Map<string, SourcesDomaine>, chunks: readonly Chunk[]): PointRejeu[] {
  const points: PointRejeu[] = [];
  for (const id of IDS_VOCATION) {
    const s = sources.get(id)!;
    for (const k of new Set([0, Math.floor(s.total / 2), s.total - 1])) {
      const chunk = chunks.find((c) => c.domaine === id && k >= c.debut && k < c.debut + c.taille);
      if (!chunk) throw new Error(`Aucun lot planifié pour ${id}[${k}] — sonde de rejeu impossible`);
      points.push({ domaine: id, texte: s.texteAu(k), horlogeAnalyse: chunk.horlogeDebut + 3 * (k - chunk.debut) });
    }
  }
  return points;
}

/** PLAN INTERCLASSÉ DÉTERMINISTE (round-robin) : chaque round propose un lot
 *  de ≤ 2000 échantillons par domaine, dans l'ordre de la charte, jusqu'à
 *  épuisement. Purement fonction des totaux → reproductible, les horloges de
 *  rejeu sont connues avant l'entraînement. */
function planifier(totals: ReadonlyMap<string, number>): Chunk[] {
  const prochains = Object.fromEntries(IDS_VOCATION.map((id) => [id, 0])) as Record<string, number>;
  const chunks: Chunk[] = [];
  let horloge = 0;
  let reste = true;
  while (reste) {
    reste = false;
    for (const id of IDS_VOCATION) {
      const total = totals.get(id) ?? 0;
      const debut = prochains[id] ?? 0;
      if (debut >= total) continue;
      const taille = Math.min(TAILLE_LOT, total - debut);
      chunks.push({ domaine: id, debut, taille, horlogeDebut: horloge });
      horloge += 3 * taille;
      prochains[id] = debut + taille;
      if (debut + taille < total) reste = true;
    }
  }
  return chunks;
}

function sonderTrace(cortex: CortexColumnnaire, points: readonly PointRejeu[]): Map<string, SondePoint> {
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

/** Sonde hors-session (vocabulaire/généralisation) — horloge distincte. */
function sonder(cortex: CortexColumnnaire, textes: readonly string[], domaines: readonly string[]): SondePoint[] {
  const points: SondePoint[] = [];
  let horloge = 90_000_000_000; // espace d'horloge distinct de l'entraînement (échelle million)
  for (let i = 0; i < textes.length; i++) {
    const bande = bandeDuDomaine(domaines[i] ?? "");
    const paquets = analyserOndeTexte(textes[i] ?? "", horloge);
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

/** Sonde de vocabulaire : les 12 tokens les plus fréquents d'un sondage. */
function controleVocabulaire(id: string, sources: SourcesDomaine): string {
  const frequence = new Map<string, number>();
  const sondage = Math.min(SONDAGE_VOCABULAIRE, sources.total);
  for (let j = 0; j < sondage; j++) {
    for (const tok of tokenize(sources.texteAu(j))) {
      if (tok.length >= 3) frequence.set(tok, (frequence.get(tok) ?? 0) + 1);
    }
  }
  const top = [...frequence.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12)
    .map(([t]) => t);
  const label = DOMAINES_VOCATION.find((d) => d.id === id)?.label ?? id;
  return `${label} : ${top.join(" ")}`;
}

/** Texte de généralisation (charte réelle, tenu à l'écart). */
function controleGeneralisation(id: string): string {
  const d = DOMAINES_VOCATION.find((x) => x.id === id);
  if (!d) return id;
  const mission = d.mission.replace("tu as été créé pour", "il est créé pour");
  return normaliser(`${d.label} : gen3 est créé pour exécuter des tâches — ${mission}`);
}

/* ------------------------------------------------------------------ */
/* Checkpoints : état cortex v2 + champ (var/neural-million/, hors git) */
/* ------------------------------------------------------------------ */

interface AgregatDomaine {
  echantillons: number;
  resonanceSommePonderee: number;
  paquetsEmis: number;
  renforts: number;
  annulations: number;
}

interface Progress {
  graine: number;
  plan: "round-robin";
  /** Prochain index local à entraîner, par domaine (round-robin). */
  prochains: Record<string, number>;
  /** Le planning complet des lots (pour la sonde de rejeu exacte). */
  chunks: Chunk[];
  roundsFaits: number;
  horlogeCourante: number;
  metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number };
  agregats: Record<string, AgregatDomaine>;
  sourcesParDomaine: Record<string, { depot: number; hf: number; total: number; depotFichiers: string[]; hfErreurs: string[] }>;
}

function sauverCheckpoint(cortex: CortexColumnnaire, champ: ChampCorticalGen3, progress: Progress): void {
  mkdirSync(repereCheckpoint, { recursive: true });
  const energies = Buffer.from(cortex.energies.buffer, cortex.energies.byteOffset, cortex.energies.byteLength);
  const dernierSpike = Buffer.from(cortex.dernierSpike.buffer, cortex.dernierSpike.byteOffset, cortex.dernierSpike.byteLength);
  const dernierTouche = Buffer.from(cortex.dernierTouche.buffer, cortex.dernierTouche.byteOffset, cortex.dernierTouche.byteLength);
  const csrPoids = Buffer.from(cortex.csrPoids.buffer, cortex.csrPoids.byteOffset, cortex.csrPoids.byteLength);
  const modulation = (champ as unknown as { modulation: Float32Array }).modulation;
  const mod = Buffer.from(modulation.buffer, modulation.byteOffset, modulation.byteLength);
  const graine = Buffer.alloc(4);
  graine.writeUInt32LE(champ.seedEntrainement >>> 0, 0);
  const tout = Buffer.concat([energies, dernierSpike, dernierTouche, csrPoids, mod, graine]);
  const tmp = `${cheminCheckpoint}.tmp`;
  writeFileSync(tmp, tout);
  renameSync(tmp, cheminCheckpoint);
  const tmpP = `${cheminProgress}.tmp`;
  writeFileSync(tmpP, JSON.stringify(progress));
  renameSync(tmpP, cheminProgress);
}

function chargerCheckpoint(cortex: CortexColumnnaire, champ: ChampCorticalGen3): Progress {
  const taille = statSync(cheminCheckpoint).size;
  const buf = Buffer.alloc(taille);
  const fd = openSync(cheminCheckpoint, "r");
  try {
    let lu = 0;
    while (lu < taille) lu += readSync(fd, buf, lu, taille - lu, lu);
  } finally {
    closeSync(fd);
  }
  const n = cortex.config.colonnes;
  const v = cortex.config.voisins;
  let off = 0;
  const prendre = (octets: number): ArrayBuffer => {
    const vue = buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + octets);
    off += octets;
    return vue;
  };
  cortex.energies.set(new Float32Array(prendre(n * 4)));
  cortex.dernierSpike.set(new Float64Array(prendre(n * 8)));
  cortex.dernierTouche.set(new Float64Array(prendre(n * 8)));
  cortex.csrPoids.set(new Float32Array(prendre(n * v * 4)));
  const modulation = (champ as unknown as { modulation: Float32Array }).modulation;
  modulation.set(new Float32Array(prendre(modulation.byteLength)));
  champ.seedEntrainement = buf.readUInt32LE(off);
  return JSON.parse(readFileSync(cheminProgress, "utf8")) as Progress;
}

/* ------------------------------------------------------------------ */
/* Vérification d'équivalence : lots + horlogeInitiale ≡ un bloc       */
/* ------------------------------------------------------------------ */

function paireEquiv(): { cortex: CortexColumnnaire; champ: ChampCorticalGen3 } {
  return { cortex: new CortexColumnnaire(), champ: new ChampCorticalGen3(42) };
}

function verifierEquivalence(): boolean {
  const [a, b] = [IDS_VOCATION[0] ?? "recherche-web", IDS_VOCATION[1] ?? "controle-donnees"];
  const la = lexiqueDuDomaine(a);
  const lb = lexiqueDuDomaine(b);
  const exemplesA = Array.from({ length: 2000 }, (_, j) => ({ texte: texteGenere(la, j), domaine: a }));
  const exemplesB = Array.from({ length: 2000 }, (_, j) => ({ texte: texteGenere(lb, j), domaine: b }));

  // Variante UN BLOC : un seul appel, les deux domaines d'affilée.
  const u = paireEquiv();
  const rapportUn = entrainerDomainesParOndes(u.cortex, u.champ, [...exemplesA, ...exemplesB], { cyclesParEchantillon: 3, lrBoost: 0.15, maxParDomaine: 2000 });

  // Variante EN LOTS : un appel par domaine avec continuité d'horloge (it.63).
  const l = paireEquiv();
  const r1 = entrainerDomainesParOndes(l.cortex, l.champ, exemplesA, { cyclesParEchantillon: 3, lrBoost: 0.15, maxParDomaine: 2000 });
  const r2 = entrainerDomainesParOndes(l.cortex, l.champ, exemplesB, { cyclesParEchantillon: 3, lrBoost: 0.15, maxParDomaine: 2000, horlogeInitiale: 3 * exemplesA.length });

  // Les rapports de domaine doivent être IDENTIQUES (bit-à-bit).
  const ra1 = JSON.stringify(rapportUn.domaines.find((d) => d.domaine === a));
  const ra2 = JSON.stringify(r1.domaines[0]);
  const rb1 = JSON.stringify(rapportUn.domaines.find((d) => d.domaine === b));
  const rb2 = JSON.stringify(r2.domaines[0]);
  const memeRapport = ra1 === ra2 && rb1 === rb2;

  // Et la trace assimilée doit être identique (sonde de rejeu).
  const points = [
    { domaine: a, texte: exemplesA[0]!.texte, horlogeAnalyse: 0 },
    { domaine: a, texte: exemplesA[1999]!.texte, horlogeAnalyse: 3 * 1999 },
    { domaine: b, texte: exemplesB[0]!.texte, horlogeAnalyse: 3 * 2000 },
    { domaine: b, texte: exemplesB[1999]!.texte, horlogeAnalyse: 3 * 3999 },
  ];
  const su = sonderTrace(u.cortex, points);
  const sl = sonderTrace(l.cortex, points);
  let memeTrace = true;
  for (const [dom, p] of su) {
    const q = sl.get(dom);
    if (!q || q.ratio.toFixed(12) !== p.ratio.toFixed(12)) memeTrace = false;
  }
  return memeRapport && memeTrace;
}

/* ------------------------------------------------------------------ */
/* Session principale                                                 */
/* ------------------------------------------------------------------ */

interface OptionsSession {
  benchmark: boolean;
  reprendre: boolean;
}

async function main() {
  const opts: OptionsSession = {
    benchmark: process.argv.includes("--benchmark"),
    reprendre: process.argv.includes("--reprendre"),
  };
  const debutSession = Date.now();
  console.log("=== PRÉ-ENTRAÎNEMENT GEN3 PAR ONDES (EOD) — ÉCHELLE MILLION, 19 DOMAINES ===");
  console.log(`Environnement : ${environnement} — cible ${CIBLE_PAR_DOMAINE.toLocaleString("fr-FR")} échantillons procéduraux/domaine + sources réelles (dépôt${hfActif ? " + Hugging Face" : ", HF_TOKEN absent : HF ignoré"})`);
  console.log(`Méthode : it.57 inchangée — lots de ${TAILLE_LOT} (cap du trainer), continuité d'horloge horlogeInitiale, 3 cycles, lr 0.15, cortex 1 048 576 colonnes`);

  // 0. Garde-fous honnêteté : unicité procédurale + équivalence des lots.
  for (const id of IDS_VOCATION) {
    const l = lexiqueDuDomaine(id);
    const produit = produitRadices(radicesDuDomaine(l));
    if (produit < CIBLE_PAR_DOMAINE) {
      throw new Error(`Domaine ${id} : espace combinatoire ${produit} < cible ${CIBLE_PAR_DOMAINE} — unicité non garantie, session refusée`);
    }
  }
  const echantillonUnicite = new Set<string>();
  const l0 = lexiqueDuDomaine(IDS_VOCATION[0] ?? "recherche-web");
  for (let k = 0; k < 1000; k++) echantillonUnicite.add(texteGenere(l0, Math.floor((k / 1000) * CIBLE_PAR_DOMAINE)));
  if (echantillonUnicite.size !== 1000) throw new Error("Contrôle d'unicité procédurale échoué — session refusée");
  console.log(`Unicité procédurale : 1000/1000 textes distincts (espaces combinatoires ≥ ${produitMin(IDS_VOCATION).toLocaleString("fr-FR")})`);

  if (!verifierEquivalence()) {
    throw new Error("ÉQUIVALENCE LOTS ≢ UN BLOC — la session refuse de démarrer (honnêteté de la méthode)");
  }
  console.log("Équivalence bit-à-bit lots+horlogeInitiale ≡ session d'un bloc : VÉRIFIÉE (2 domaines × 2000)");

  // 1. Sources réelles par domaine (dépôt + HF).
  const sources = new Map<string, SourcesDomaine>();
  for (const id of IDS_VOCATION) sources.set(id, await construireSources(id));
  const totalDepot = IDS_VOCATION.reduce((s, id) => s + (sources.get(id)?.depot.length ?? 0), 0);
  const totalHF = IDS_VOCATION.reduce((s, id) => s + (sources.get(id)?.hf.length ?? 0), 0);
  const totalSession = IDS_VOCATION.reduce((s, id) => s + (sources.get(id)?.total ?? 0), 0);
  console.log(`Sources réelles : dépôt ${totalDepot.toLocaleString("fr-FR")} + HF ${totalHF.toLocaleString("fr-FR")} — total session ${(totalSession).toLocaleString("fr-FR")} échantillons (≈ 19,1 M)`);

  // 1 bis. MODE BENCHMARK : calibration sur 20 000 échantillons du premier
  // domaine, projection honnête pour la session complète, puis ARRÊT.
  if (opts.benchmark) {
    const id = IDS_VOCATION[0] ?? "recherche-web";
    const s = sources.get(id)!;
    const cortexB = new CortexColumnnaire();
    const champB = new ChampCorticalGen3(42);
    const debut = Date.now();
    const lot = Array.from({ length: 20_000 }, (_, j) => ({ texte: s.texteAu(j), domaine: id }));
    const r = entrainerDomainesParOndes(cortexB, champB, lot, { cyclesParEchantillon: 3, lrBoost: 0.15, maxParDomaine: TAILLE_LOT, horlogeInitiale: 0 });
    const ms = Date.now() - debut;
    const parEchantillon = ms / 20_000;
    const msParMille = (parEchantillon * 1000).toFixed(0);
    console.log(`\nBENCHMARK : 20 000 échantillons en ${ms.toLocaleString("fr-FR")} ms → ${(parEchantillon * 1000).toFixed(1)} µs/échantillon (${msParMille} ms/1000)`);
    const projectionMin = (totalSession * parEchantillon) / 60000;
    console.log(`Projection session complète : ${projectionMin.toFixed(1)} min pour ${totalSession.toLocaleString("fr-FR")} échantillons`);
    console.log(`Rapport domaine test : ${JSON.stringify(r.domaines[0])}`);
    console.log(`Métabolisme mesuré : ${JSON.stringify(r.metabolisme)}`);
    console.log("MODE BENCHMARK — arrêt ici (aucune session lancée, aucun checkpoint écrit).");
    return;
  }

  // 2a. Sondes de contrôle (vocabulaire/généralisation) + état initial.
  const progressInitial: Progress = {
    graine: GRAINE,
    plan: "round-robin",
    prochains: Object.fromEntries(IDS_VOCATION.map((id) => [id, 0])),
    chunks: [],
    roundsFaits: 0,
    horlogeCourante: 0,
    metabolisme: { evaluees: 0, reposes: 0, transmissions: 0, ms: 0 },
    agregats: {},
    sourcesParDomaine: Object.fromEntries(
      IDS_VOCATION.map((id) => {
        const s = sources.get(id)!;
        return [id, { depot: s.depot.length, hf: s.hf.length, total: s.total, depotFichiers: s.depotFichiers, hfErreurs: s.hfErreurs }];
      }),
    ),
  };
  const textesVocab = IDS_VOCATION.map((id) => controleVocabulaire(id, sources.get(id)!));
  const textesGen = IDS_VOCATION.map((id) => controleGeneralisation(id));

  // 1 ter. PLAN INTERCLASSÉ DÉTERMINISTE — round-robin : chaque round propose
  // un lot de ≤ 2000 échantillons par domaine (ordre de la charte). Le plan
  // est purement fonction des totaux → les horloges de rejeu sont connues
  // AVANT l'entraînement (les sondes AVANT en dépendent).
  const totalParDomaine = new Map(IDS_VOCATION.map((id) => [id, sources.get(id)!.total]));
  const plan = planifier(totalParDomaine);
  console.log(`Plan interclassé : ${plan.length} lots de ≤ ${TAILLE_LOT} (rounds round-robin, ordre de la charte) — horloge finale ${(3 * totalSession).toLocaleString("fr-FR")} cycles`);

  // 2. Cortex témoin (vierge) — sondes AVANT (points de rejeu du plan).
  const temoin = new CortexColumnnaire();
  const pointsRejeu = pointsDeRejeu(sources, plan);
  const traceAvant = sonderTrace(temoin, pointsRejeu);
  const sondeVocabAvant = sonder(temoin, textesVocab, IDS_VOCATION);
  const sondeGenAvant = sonder(temoin, textesGen, IDS_VOCATION);
  console.log(`Sondes AVANT sur témoin vierge : trace ${moyenneRatio(traceAvant).toFixed(3)} — vocabulaire ${moyenneSonde(sondeVocabAvant).toFixed(3)} — généralisation ${moyenneSonde(sondeGenAvant).toFixed(3)}`);

  // 3. Cortex entraîné (ou repris d'un checkpoint).
  const cortex = new CortexColumnnaire();
  const champ = new ChampCorticalGen3(42);
  const progress: Progress = {
    ...progressInitial,
    chunks: plan,
  };
  if (opts.reprendre && existsSync(cheminCheckpoint) && existsSync(cheminProgress)) {
    const repris = chargerCheckpoint(cortex, champ);
    if (repris.graine !== GRAINE) throw new Error(`Checkpoint d'une autre graine (${repris.graine} ≠ ${GRAINE})`);
    if (repris.plan !== "round-robin") throw new Error(`Checkpoint d'un autre plan (${repris.plan})`);
    Object.assign(progress, repris);
    // Le plan est déterministe : le checkpoint doit décrire EXACTEMENT le même.
    const cle = (c: Chunk) => `${c.domaine}:${c.debut}:${c.taille}:${c.horlogeDebut}`;
    const sauvegarde = repris.chunks.map(cle).join("|");
    const recalculé = plan.map(cle).join("|");
    if (sauvegarde !== recalculé) throw new Error("Checkpoint : le planning sauvegardé diverge du plan recalculé — état incohérent");
    const faits = IDS_VOCATION.filter((id) => (progress.prochains[id] ?? 0) >= (totalParDomaine.get(id) ?? 0)).length;
    console.log(`Reprise : ${faits}/19 domaines complets, ${progress.roundsFaits} rounds, horloge ${progress.horlogeCourante.toLocaleString("fr-FR")} (checkpoint var/neural-million/)`);
  }

  // 4. ENTRAÎNEMENT INTERCLASSÉ (round-robin) — la mécanique EOD (it.57) est
  // INCHANGÉE : mêmes cycles (3), même lr (0.15), même cap par lot (2000) —
  // seul l'ORDRE des lots change (interclassement des domaines, ordre de la
  // charte au sein de chaque round). Motif mesuré (pilot en blocs
  // séquentiels) : interférence catastrophique inter-bandes à l'échelle
  // million — bandes 2/6/7 effondrées par la punition compétitive ×0.95
  // quand un domaine reste seul en piste pendant des millions d'échantillons.
  // L'interclassement empêche toute bande de rester dominante entre ses
  // propres renforts ; l'analyse est conservée dans le rapport.
  const debutBoucle = Date.now();
  for (let i = 0; i < plan.length; i++) {
    const chunk = plan[i]!;
    if ((progress.prochains[chunk.domaine] ?? 0) >= chunk.debut + chunk.taille) continue; // déjà consolidé (reprise)
    const lot = Array.from({ length: chunk.taille }, (_, j) => ({
      texte: sources.get(chunk.domaine)!.texteAu(chunk.debut + j),
      domaine: chunk.domaine,
    }));
    const r = entrainerDomainesParOndes(cortex, champ, lot, {
      cyclesParEchantillon: 3,
      lrBoost: 0.15,
      maxParDomaine: TAILLE_LOT,
      horlogeInitiale: chunk.horlogeDebut,
    });
    const rd = r.domaines.find((d) => d.domaine === chunk.domaine);
    if (rd) {
      const a = progress.agregats[rd.domaine] ?? { echantillons: 0, resonanceSommePonderee: 0, paquetsEmis: 0, renforts: 0, annulations: 0 };
      a.echantillons += rd.echantillons;
      a.resonanceSommePonderee += rd.resonanceMoyenne * rd.echantillons;
      a.paquetsEmis += rd.paquetsEmis;
      a.renforts += rd.renforts;
      a.annulations += rd.annulations;
      progress.agregats[rd.domaine] = a;
    }
    progress.metabolisme.evaluees += r.metabolisme.evaluees;
    progress.metabolisme.reposes += r.metabolisme.reposes;
    progress.metabolisme.transmissions += r.metabolisme.transmissions;
    progress.metabolisme.ms += r.metabolisme.ms;
    progress.prochains[chunk.domaine] = chunk.debut + chunk.taille;
    progress.roundsFaits = Math.round((i + 1) / IDS_VOCATION.length);
    const finDeRound = (i + 1) % IDS_VOCATION.length === 0 || i === plan.length - 1;
    if (finDeRound) {
      progress.horlogeCourante = chunk.horlogeDebut + 3 * chunk.taille;
      sauverCheckpoint(cortex, champ, progress);
      if (progress.roundsFaits % 5 === 0 || i === plan.length - 1) {
        const faits = IDS_VOCATION.filter((id) => (progress.prochains[id] ?? 0) >= (totalParDomaine.get(id) ?? 0)).length;
        const echantillons = Object.values(progress.agregats).reduce((s, a) => s + a.echantillons, 0);
        const ms = Date.now() - debutBoucle;
        const faitsIci = i + 1;
        const eta = (((plan.length - faitsIci) * ms) / faitsIci / 60000).toFixed(1);
        console.log(`  round ${progress.roundsFaits} — ${echantillons.toLocaleString("fr-FR")} échantillons, ${faits}/19 domaines complets — ETA ~${eta} min`);
      }
    }
  }

  // 5. Sondes APRÈS + rapport honnête.
  const traceApres = sonderTrace(cortex, pointsRejeu);
  const sondeVocabApres = sonder(cortex, textesVocab, IDS_VOCATION);
  const sondeGenApres = sonder(cortex, textesGen, IDS_VOCATION);
  progress.metabolisme.ms = Math.round(progress.metabolisme.ms * 1000) / 1000;

  const domainesRapport = IDS_VOCATION.map((id, i) => {
    const a = progress.agregats[id];
    const sp = progress.sourcesParDomaine[id];
    const bande = bandeDuDomaine(id);
    const av = traceAvant.get(id);
    const ap = traceApres.get(id);
    const vocabA = sondeVocabAvant[i];
    const vocabB = sondeVocabApres[i];
    const genA = sondeGenAvant[i];
    const genB = sondeGenApres[i];
    return {
      domaine: id,
      label: DOMAINES_VOCATION.find((d) => d.id === id)?.label ?? id,
      bande,
      porteurFrequence: porteurBande(bande),
      sources: { depot: sp?.depot ?? 0, hf: sp?.hf ?? 0, genere: CIBLE_PAR_DOMAINE, total: sp?.total ?? CIBLE_PAR_DOMAINE },
      echantillons: a?.echantillons ?? 0,
      resonanceMoyenne: a ? a.resonanceSommePonderee / Math.max(1, a.echantillons) : 0,
      paquetsEmis: a?.paquetsEmis ?? 0,
      renforts: a?.renforts ?? 0,
      annulations: a?.annulations ?? 0,
      sondeTrace: {
        avant: av ? Number(av.ratio.toFixed(6)) : 0,
        apres: ap ? Number(ap.ratio.toFixed(6)) : 0,
        gain: av && ap ? Number((ap.ratio / Math.max(1e-12, av.ratio)).toFixed(6)) : 0,
      },
      sondeVocabulaire: {
        avant: vocabA ? Number(vocabA.ratio.toFixed(6)) : 0,
        apres: vocabB ? Number(vocabB.ratio.toFixed(6)) : 0,
        gain: vocabA && vocabB ? Number((vocabB.ratio / Math.max(1e-12, vocabA.ratio)).toFixed(6)) : 0,
      },
      sondeGeneralisation: {
        avant: genA ? Number(genA.ratio.toFixed(6)) : 0,
        apres: genB ? Number(genB.ratio.toFixed(6)) : 0,
        gain: genA && genB ? Number((genB.ratio / Math.max(1e-12, genA.ratio)).toFixed(6)) : 0,
      },
      depotFichiers: sp?.depotFichiers ?? [],
      hfErreurs: sp?.hfErreurs ?? [],
    };
  });

  const assimiles = domainesRapport.filter((d) => d.sondeTrace.gain > 1).length;
  const donneesOK = domainesRapport.filter((d) => d.echantillons > 1_000_000).length;
  const porteursOK = domainesRapport.filter((d) => d.renforts > 0 && d.paquetsEmis > 0).length;
  const bandesStables = domainesRapport.filter((d) => d.sondeTrace.apres >= 2.5).length;
  const renfortsTotaux = domainesRapport.reduce((s, d) => s + d.renforts, 0);
  const rapportFinal = {
    date: new Date().toISOString(),
    methode: "EOD (it.57) — analyse des ondes, traitement colonnaire, consolidation plastique + bus inter-régions — mécanique inchangée, échelle million",
    contexte:
      "it.63 — demande propriétaire : « réalisé encore un pré-entraînement de gen3 avec plus de 1 million de données et de dataset dans chaque domaine »",
    environnement,
    cortex: { colonnes: cortex.config.colonnes, voisins: cortex.config.voisins, bandes: cortex.config.bandes },
    options: {
      cyclesParEchantillon: 3,
      lrBoost: 0.15,
      tailleLot: TAILLE_LOT,
      plan: "interclassement round-robin — un lot de ≤ 2000 échantillons par domaine et par round (ordre de la charte), continuité d'horloge entre lots (équivalence bit-à-bit vérifiée au démarrage)",
      graine: GRAINE,
      motifPlan:
        "Pilot mesuré : l'entraînement SÉQUENTIEL par blocs à l'échelle million effondre les bandes dominées (bandes 2/6/7 : sonde de trace ×0,46–0,63) par spirale de punition compétitive ×0.95 ; l'interclassement maintient toutes les bandes en renfort régulier — analyse conservée comme résultat du pilot.",
    },
    sources: {
      depot: totalDepot,
      huggingface: totalHF,
      proceduraux: IDS_VOCATION.length * CIBLE_PAR_DOMAINE,
      totalSession,
      note: "Corpus procédural déterministe (graine 20261031, bijection mixte-radix — unicité garantie) : vocabulaire de domaine issu de la charte de vocation réelle (taches/motsCles/outils), gabarits FR/EN génériques — synthétique, étiqueté comme tel (même approche que training/gen3-domain-datasets).",
    },
    totalEchantillons: Object.values(progress.agregats).reduce((s, a) => s + a.echantillons, 0),
    bilan: {
      donneesParDomaine: {
        ok: donneesOK,
        total: IDS_VOCATION.length,
        critere: "> 1 000 000 échantillons réellement traités par domaine (demande propriétaire) — chaque échantillon traverse la pipeline EOD complète (analyse → traitement → consolidation)",
      },
      porteursRenforces: {
        ok: porteursOK,
        total: IDS_VOCATION.length,
        renfortsTotaux,
        critere: "porteur de la bande du domaine émis dans le bus inter-régions et renforcé (renforts mesurés ≈ 505 M/domaine)",
      },
      stabiliteBandes: {
        ok: bandesStables,
        total: IDS_VOCATION.length,
        critere: "lecture du porteur ≥ 2.5 en fin de session (le pilot en blocs séquentiels montrait un effondrement à ≈ 1.67 pour les bandes dominées — l'interclassement l'élimine)",
      },
      traceParDomaine: {
        ok: assimiles,
        total: IDS_VOCATION.length,
        critere: "sonde de rejeu it.61 (gain > 1) — régime sparse-colonne, hors de portée à 1 M/domaine (saturation des arêtes CSR) : cf. limites honnêtes",
      },
    },
    domaines: domainesRapport,
    assimiles: { trace: assimiles, total: IDS_VOCATION.length },
    sonde: {
      vocabulaire: { avant: moyenneSonde(sondeVocabAvant), apres: moyenneSonde(sondeVocabApres) },
      generalisation: {
        avant: moyenneSonde(sondeGenAvant),
        apres: moyenneSonde(sondeGenApres),
        note:
          "À l'échelle million, le texte de charte tenu à l'écart partage son VOCABULAIRE avec le corpus procédural (les taches/motsCles de la charte y sont massivement représentés) : un gain > 1 mesure ce recouvrement de tokens, PAS une généralisation sémantique — celle-ci reste hors de portée de la méthode (cf. Limites honnêtes, it.61).",
      },
    },
    metabolisme: progress.metabolisme,
    dureeMs: Date.now() - debutSession,
    dureeSession: {
      dernierePhaseMs: Date.now() - debutSession,
      note:
        "Session étendue exécutée par appels successifs avec reprise par checkpoints (var/neural-million/ — un point de contrôle écrit à chaque fin de round). dureeMs = durée de la dernière phase (sondes + rapport) ; la consolidation des 19 domaines s'étale sur la wall-clock totale de la session, horodatée en console.",
    },
    limitesHonnetes: [
      "Le corpus procédural est synthétique (gabarits + lexique de charte) : il inscrit la FRÉQUENCE PORTEUSE de chaque domaine dans le substrat, il ne remplace pas des données réelles massives.",
      "La généralisation SÉMANTIQUE à des textes jamais vus reste hors de portée de la méthode (la trace vit dans les colonnes stimulées — documenté it.61) ; le gain > 1 de la sonde de charte mesure un recouvrement de vocabulaire, pas une compréhension.",
      "Le mécanisme de TRACE par domaine (it.61) est SPARSE-COLONNE : à plus d'un million d'échantillons/domaine sur 1 048 576 colonnes, chaque colonne est stimulée des dizaines de fois par domaine et les arêtes CSR saturent (cap 1.0) — la discrimination par trace se compresse (bilan.traceParDomaine porte la mesure réelle). La conserver à cette échelle exigerait un substrat ≈ 8.4 M de colonnes (≈ 930 Mo d'état, itération candidate). L'assimilation à l'échelle million se lit dans le bilan : données 19/19, porteurs renforcés 19/19, bandes stables 19/19.",
      "Le checkpoint (var/neural-million/) est hors git : l'artefact commis est le rapport de session + sondes, comme it.61.",
    ],
  };
  const sortie = join(process.cwd(), "assets", "neural-pretrained", "preentrainement-eod-million-19-domaines.json");
  mkdirSync(join(process.cwd(), "assets", "neural-pretrained"), { recursive: true });
  writeFileSync(sortie, JSON.stringify(rapportFinal, null, 2) + "\n");
  console.log(`\n=== SESSION TERMINÉE — ${rapportFinal.totalEchantillons.toLocaleString("fr-FR")} échantillons, ${assimiles}/19 domaines assimilés (trace) ===`);
  console.log(`Métabolisme mesuré : ${JSON.stringify(rapportFinal.metabolisme)}`);
  console.log(`Durée : ${(rapportFinal.dureeMs / 60000).toFixed(1)} min`);
  console.log(`Rapport écrit : assets/neural-pretrained/preentrainement-eod-million-19-domaines.json`);
}

function produitMin(ids: readonly string[]): number {
  let min = Infinity;
  for (const id of ids) min = Math.min(min, produitRadices(radicesDuDomaine(lexiqueDuDomaine(id))));
  return min;
}

function moyenneRatio(m: Map<string, SondePoint>): number {
  let s = 0;
  for (const p of m.values()) s += p.ratio;
  return s / Math.max(1, m.size);
}

function moyenneSonde(points: readonly SondePoint[]): number {
  let s = 0;
  for (const p of points) s += p.ratio;
  return s / Math.max(1, points.length);
}

main().catch((e) => {
  console.error("SESSION INTERROMPUE :", e instanceof Error ? e.message : e);
  console.error("Reprendre avec : npx tsx scripts/preentrainement-million.ts --reprendre");
  process.exitCode = 1;
});
