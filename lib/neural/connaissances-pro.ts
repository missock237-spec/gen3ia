import "server-only";

/**
 * CONNAISSANCES PROFESSIONNELLES v5 — ingestion cortex au démarrage
 * (Job 478451 : datasets professionnels réels HF/Kaggle + corpus calculés).
 *
 * Le cerveau Gen3 apprend AU DÉMARRAGE les connaissances professionnelles v5
 * (miroir du pattern abbreviations.ts) :
 *   - couleurs_v5                 : reconnaissance, propriétés, mélanges (XKCD + calculs exacts) ;
 *   - math_professionnel          : GSM8K réel (HF openai/gsm8k) ;
 *   - sciences_professionnel      : ARC réel (HF allenai/ai2_arc) ;
 *   - raisonnement_professionnel  : raisonnement multi-étapes à réponses exactes ;
 *   - vision_professionnel        : images réelles CIFAR-10 étiquetées ;
 *   - parole_professionnelle      : LibriSpeech réel (transcriptions vérifiées) ;
 *   - texte_professionnel         : wikitext-2 + dbpedia_14 réels.
 *
 * Idempotent via marqueur var/neural/connaissances-pro-v1.json. Les quotas
 * restent sous MAX_PAIRES_PERSONNALISEES (20 000) pour laisser la place aux
 * paires apprises de l'utilisateur (Studio / auto-apprentissage).
 *
 * Les réponses EXACTES restent garanties par les SOLVEURS (moteur-couleurs,
 * moteur-calcul) branchés dans engine.composer — les paires ici apportent la
 * couverture conversationnelle (phrasings variés), les solveurs la précision
 * mathématique/computationnelle sur toute question nouvelle.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { PaireLangage } from "./generation/corpus";

/** Sources v5 ingérées au démarrage + quotas de paires. */
const SOURCES_V5: Array<{ dossier: string; theme: string; quota: number; priorite: number }> = [
  { dossier: "couleurs_v5", theme: "couleurs-professionnel", quota: 2400, priorite: 1 },
  { dossier: "raisonnement_professionnel", theme: "raisonnement-professionnel", quota: 2200, priorite: 2 },
  { dossier: "math_professionnel", theme: "math-professionnel", quota: 2200, priorite: 3 },
  { dossier: "sciences_professionnel", theme: "sciences-professionnel", quota: 1600, priorite: 4 },
  { dossier: "vision_professionnel", theme: "vision-professionnel", quota: 800, priorite: 5 },
  { dossier: "texte_professionnel", theme: "texte-professionnel", quota: 500, priorite: 6 },
  { dossier: "parole_professionnelle", theme: "parole-professionnelle", quota: 200, priorite: 7 },
];

const FICHIER_MARQUEUR = path.join(
  process.cwd(),
  "var",
  "neural",
  "connaissances-pro-v1.json",
);

interface LigneV5 {
  instruction: string;
  output: string;
  task_type: string;
  language: string;
  domain: string;
}

export interface ResultatIngestionConnaissances {
  ingere: boolean;
  paires: number;
  parSource: Record<string, number>;
  dureeMs: number;
}

/**
 * Construit les paires cortex depuis les datasets v5.
 * Motif : première phrase de l'instruction (le cortex matche par tokens —
 * même contrat que construirePairesDomaines). Réponse : output complet
 * (tronqué à 700 caractères pour garder le cortex léger).
 */
export async function construirePairesConnaissancesPro(
  parSourceQuota = 2200,
): Promise<{ paires: PaireLangage[]; parSource: Record<string, number> }> {
  const paires: PaireLangage[] = [];
  const parSource: Record<string, number> = {};

  for (const source of SOURCES_V5) {
    const chemin = path.join(
      process.cwd(),
      "datasets",
      source.dossier,
      "train.jsonl",
    );
    let brut: string | null = null;
    try {
      brut = await readFile(chemin, "utf8");
    } catch {
      parSource[source.dossier] = 0; // déployé sans ce dataset : dégradation honnête
      continue;
    }
    let prises = 0;
    let vu = 0;
    const motifsVus = new Set<string>();
    for (const ligne of brut.split("\n")) {
      if (prises >= Math.min(source.quota, parSourceQuota)) break;
      if (!ligne.trim()) continue;
      vu++;
      if (vu > 60000) break; // garde-fou temps de boot
      let objet: LigneV5;
      try {
        objet = JSON.parse(ligne) as LigneV5;
      } catch {
        continue;
      }
      if (!objet.instruction || !objet.output) continue;
      const motif = objet.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
      if (motif.length < 12) continue;
      const cle = motif.toLowerCase();
      if (motifsVus.has(cle)) continue;
      motifsVus.add(cle);
      paires.push({
        motif,
        reponse: objet.output.slice(0, 700),
        theme: source.theme,
      });
      prises++;
    }
    parSource[source.dossier] = prises;
  }

  return { paires, parSource };
}

/**
 * Ingestion one-shot au démarrage du runtime (idempotent). Le runtime passe
 * une fonction d'apprentissage (cortex.apprendre lié) pour rester découplé.
 */
export async function ingérerConnaissancesPro(
  apprendre: (paires: PaireLangage[]) => { pairesAjoutees: number } | Promise<{ pairesAjoutees: number }>,
): Promise<ResultatIngestionConnaissances> {
  const debut = Date.now();
  const resultat: ResultatIngestionConnaissances = {
    ingere: false,
    paires: 0,
    parSource: {},
    dureeMs: 0,
  };

  // Idempotence : si le marqueur existe avec des paires déjà apprises, skip.
  try {
    const marqueur = JSON.parse(await readFile(FICHIER_MARQUEUR, "utf8")) as {
      pairesApprises: number;
    };
    if (marqueur.pairesApprises > 0) {
      resultat.ingere = false;
      resultat.paires = marqueur.pairesApprises;
      resultat.dureeMs = Date.now() - debut;
      return resultat;
    }
  } catch {
    // Pas de marqueur : première ingestion (ou marqueur corrompu → re-ingest).
  }

  const { paires, parSource } = await construirePairesConnaissancesPro();
  if (paires.length > 0) {
    try {
      const stats = await apprendre(paires);
      resultat.ingere = true;
      resultat.paires = stats.pairesAjoutees;
      resultat.parSource = parSource;
    } catch {
      // Cortex indisponible : dégradation silencieuse (jamais de panne de boot).
    }
  }

  resultat.dureeMs = Date.now() - debut;
  try {
    await mkdir(path.dirname(FICHIER_MARQUEUR), { recursive: true });
    await writeFile(
      FICHIER_MARQUEUR,
      JSON.stringify(
        {
          genereLe: new Date().toISOString(),
          pairesApprises: resultat.paires,
          parSource: resultat.parSource,
          sources: SOURCES_V5.map((s) => s.dossier),
        },
        null,
        1,
      ),
      "utf8",
    );
  } catch {
    // Marqueur non persisté : la prochaine ingestion sera un no-op safest.
  }
  return resultat;
}
