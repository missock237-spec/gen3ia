import "server-only";

/**
 * ABRÉVIATIONS — le cerveau Gen3 COMPREND les abréviations FR/EN.
 *
 * Demande utilisateur : « entraîne gen3 à comprendre les abréviations ».
 * Deux mécanismes réels, sans IA externe :
 *
 *  1. EXPANSION À L'ENTRÉE : tout prompt entrant est enrichi AVANT l'encodage
 *     neuronal — chaque abréviation connue est doublée de sa forme longue
 *     (« API » → « API (interface de programmation d'applications) »). Le
 *     hachage lexical de la zone de tokens reçoit donc LES DEUX formes : la
 *     compréhension est structurelle, pas cosmétique.
 *
 *  2. INGESTION CORTEX : les paires du dataset datasets/abbreviations sont
 *     converties en PaireLangage et apprises par le cortex langagier une
 *     seule fois (idempotent via marqueur var/neural/abbreviations-v1.json)
 *     — l'IA RÉPOND correctement à « que signifie API ? » même sans réseau.
 *
 * Source de vérité : datasets/abbreviations/train.jsonl (2 145 lignes réelles
 * en v2 « géants » — ≈520 sigles FR/EN dédupliqués, voir INDEX.json). Le
 * dataset vit aussi sur le repo Hugging Face gen3ia-media-engine (publication
 * training/colab).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PaireLangage } from "./generation/corpus";

/** Ligne du dataset abréviations (sous-ensemble utile au runtime). */
interface LigneAbreviation {
  id: string;
  task_type: string;
  language: string;
  instruction: string;
  input: string;
  output: string;
}

/** Abréviation → forme longue (française privilégiée, anglaise en repli). */
const EXPANSIONS = new Map<string, string>();
/** Sigle en minuscules → SIGLE ORIGINAL (casse typographique, pour matcher
 *  « SaaS » sans toucher « saas » inconnu). */
const ORIGINAUX = new Map<string, string>();
/** Abréviation → réponse pédagogique complète (expansion directe). */
const REPONSES = new Map<string, string>();
/** Forme longue normalisée → sigle (tâche inverse — désambiguïsation du
 *  sens « abréger » ; NE pollue PAS les cartes d'expansion). */
const INVERSES = new Map<string, string>();

let charge = false;
let chargement: Promise<void> | null = null;

function cheminDataset(): string {
  return path.join(process.cwd(), "datasets", "abbreviations", "train.jsonl");
}

function marqueurIngestion(): string {
  return path.join(process.cwd(), "var", "neural", "abbreviations-v1.json");
}

/** Normalisation compatible tokenize() : minuscules, sans diacritiques. */
function normaliser(texte: string): string {
  return texte.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Charge le dataset une seule fois (lazy, thread-safe via promesse partagée). */
export function chargerAbréviations(): Promise<void> {
  if (charge) return Promise.resolve();
  if (chargement) return chargement;
  chargement = (async () => {
    try {
      const brut = await readFile(cheminDataset(), "utf8");
      for (const ligne of brut.split("\n")) {
        if (!ligne.trim()) continue;
        let row: LigneAbreviation;
        try {
          row = JSON.parse(ligne) as LigneAbreviation;
        } catch {
          continue; // ligne corrompue : ignorée, le dataset reste lisible
        }
        if (row.task_type === "expansion") {
          const m = row.output.match(/«\s*([^»]+)\s*»\s*signifie\s*«\s*([^»]+)\s*»/);
          if (m && !REPONSES.has(m[1].trim().toLowerCase())) {
            const clé = m[1].trim().toLowerCase();
            EXPANSIONS.set(clé, m[2].trim());
            ORIGINAUX.set(clé, m[1].trim());
            REPONSES.set(clé, row.output);
          }
        } else if (row.task_type === "abbreviation_reverse") {
          // input = forme longue, output = sigle — carte INVERSE isolée :
          // les lignes inverses ne doivent jamais priver une ligne
          // d'expansion (REPONSES/ORIGINAUX) de s'enregistrer ensuite.
          const longue = normaliser(row.input.trim());
          if (longue.length > 3 && !INVERSES.has(longue)) {
            INVERSES.set(longue, row.output.trim());
          }
        }
      }
      charge = true;
    } catch {
      // Dataset absent (déployé sans datasets/) : dégradation silencieuse —
      // l'expansion devient no-op, jamais une erreur de tour.
      charge = true;
    }
  })();
  return chargement;
}

/** Nombre d'abréviations chargées (télémétrie honnête). */
export function tailleDictionnaireAbréviations(): number {
  return EXPANSIONS.size;
}

/**
 * Extrait la paire (sigle, forme longue) de la première abréviation reconnue
 * dans un texte — sert aux réponses du cortex sur « que signifie X ? ».
 */
export function reconnaitreAbréviation(texte: string): { sigle: string; expansion: string } | null {
  for (const [sigle, expansion] of EXPANSIONS) {
    const motif = new RegExp(`\\b${sigle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (motif.test(texte)) return { sigle, expansion };
  }
  return null;
}

/**
 * EXPANSION À L'ENTRÉE — double chaque abréviation connue de sa forme longue.
 * « Le API du serveur » → « Le API (interface de programmation d'applications) du serveur ».
 * Honnêteté : les sigles ambigus (CA, CR) ne sont expansés qu'en forme exacte
 * majuscule (convention typographique = désambiguïsation gratuite).
 */
export function promptAvecAbréviations(prompt: string): string {
  if (!charge) return prompt;
  if (EXPANSIONS.size === 0 || prompt.length < 2) return prompt;
  let sortie = prompt;
  for (const [clé, expansion] of EXPANSIONS) {
    if (expansion.length < 4) continue; // expansions triviales inutiles
    // CASSE ORIGINALE du sigle (« SaaS », « API », « mdr ») : match exact —
    // un mot minuscule inconnu (« cap ») ne déclenche jamais « CAP ».
    const original = ORIGINAUX.get(clé) ?? clé;
    const échappé = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const motif = new RegExp(`(?<![\\p{L}\\p{N}])${échappé}(?![\\p{L}\\p{N}])`, "gu");
    sortie = sortie.replace(motif, (m) => `${m} (${expansion})`);
  }
  return sortie;
}

/** Convertit le dataset en paires cortex (motif → réponse), limité au quota. */
export function pairesAbréviationsPourCortex(max = 800): PaireLangage[] {
  const paires: PaireLangage[] = [];
  for (const [sigle, réponse] of REPONSES) {
    if (paires.length >= max) break;
    paires.push({
      motif: `que signifie ${sigle} ?`,
      reponse: réponse,
      theme: "abréviations",
    });
    if (paires.length >= max) break;
    paires.push({
      motif: `c'est quoi ${sigle}`,
      reponse: réponse,
      theme: "abréviations",
    });
  }
  return paires;
}

/**
 * INGESTION CORTEX one-shot — idempotente : un marqueur horodaté dans
 * var/neural empêche la re-ingestion à chaque démarrage (les doublons de
 * motif sont de toute façon ignorés par apprendre(), le marqueur évite
 * juste le travail).
 */
export async function ingérerAbréviationsDansCortex(
  apprendre: (paires: readonly PaireLangage[], opts?: { personnalisees?: boolean }) => { added: number; duplicates: number } | unknown,
): Promise<{ déjaFait: boolean; ajoutées: number; doublons: number } | null> {
  await chargerAbréviations();
  try {
    const contenu = await readFile(marqueurIngestion(), "utf8").catch(() => null);
    if (contenu) {
      const état = JSON.parse(contenu) as { rows?: number };
      if (état.rows && état.rows >= REPONSES.size) return { déjaFait: true, ajoutées: 0, doublons: 0 };
    }
    const paires = pairesAbréviationsPourCortex();
    const stats = (await apprendre(paires, { personnalisees: true })) as { added?: number; ajoutees?: number; duplicates?: number; doublons?: number } | unknown;
    const s = (stats ?? {}) as Record<string, number>;
    await mkdir(path.dirname(marqueurIngestion()), { recursive: true });
    await writeFile(
      marqueurIngestion(),
      JSON.stringify({ rows: REPONSES.size, at: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return {
      déjaFait: false,
      ajoutées: s.added ?? s.ajoutees ?? 0,
      doublons: s.duplicates ?? s.doublons ?? 0,
    };
  } catch {
    return null; // ingestion ratée : non bloquante, l'expansion à l'entrée reste active
  }
}
