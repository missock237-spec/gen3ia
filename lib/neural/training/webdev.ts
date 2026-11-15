import "server-only";

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import readline from "node:readline";

import { tokenize } from "../encoding/text-encoder";
import { texteEntrainement, type SignaturesDomaines } from "./domaines";

/**
 * ENTRAÎNEMENT WEB-DEV GEN3IA — couche d'expertise « développement web »
 * alimentée par le pack dédié (training/gen3-webdev-pack).
 *
 * L'objectif est explicite : que Gen3ia sache CONCEVOIR ET DÉVELOPPER des
 * produits web de bout en bout — SaaS complets, sites web, applications
 * métier, API, authentification, données, UI, déploiement, tests.
 *
 * Données : le générateur Python du pack (generateur_webdev.py) produit
 * DES MILLIONS de lignes JSONL bilingues FR/EN au schéma du dépôt
 * (instruction → output structuré avec blocs de code réels). Ce module :
 *   1. CHARGE le dataset en STREAMING (gunzip + readline) — jamais un
 *      fichier de plusieurs gigaoctets en RAM ;
 *   2. SOUS-ÉCHANTILLONNE pour l'entraînement SNN (plafond configurable —
 *      la plasticité supervisée n'a pas besoin des millions, elle a besoin
 *      d'un échantillon représentatif bien mélangé) ;
 *   3. CONSTRUIT les paires conversationnelles (instruction → réponse)
 *      pour le cortex langagier, par lots ;
 *   4. l'entraînement réel vit dans entrainement-webdev.ts.
 *
 * Tous les chemins sont relatifs au cwd du process (dépôt) ; l'ordre de
 * repli est : dataset compressé (.jsonl.gz) → dataset brut (.jsonl) →
 * échantillons commis au git (toujours présents).
 */

/** Label SNN du domaine développement web. */
export const LABEL_WEBDEV = "DOM_DEVELOPPEMENT_WEB";

const RACINE_PACK = path.join(process.cwd(), "training/gen3-domain-datasets/data");
const CHEMIN_COMPLET_GZ = path.join(RACINE_PACK, "complet/developpement_web.jsonl.gz");
const CHEMIN_COMPLET_BRUT = path.join(RACINE_PACK, "complet/developpement_web.jsonl");
const CHEMIN_ECHANTILLONS = path.join(RACINE_PACK, "echantillons/developpement_web.jsonl");

/** Échantillon JSONL du dépôt (même schéma que EchantillonDomaine). */
export interface EchantillonWebdev {
  id: string;
  domain: string;
  language: "fr" | "en";
  task_type: string;
  instruction: string;
  input: string;
  output: string;
  metadata: {
    created_at: string;
    temporal_bucket: string;
    difficulty: string;
    quality_score: number;
    source_style: string;
    bilingual_pair_id: string;
    dedup_hash: string;
    safety_label: string;
    license: string;
  };
}

/** Options de chargement plafonné (mémoire et temps bornés). */
export interface OptionsChargementWebdev {
  /** Nombre maximal de lignes retenues (défaut 60 000). */
  plafond?: number;
  /** Priorité à une langue (inventaire équilibré sinon). */
  langue?: "fr" | "en";
  /** Lire TOUT le dataset pour compter le volume réel (diagnostic honnête ;
   *  défaut false — l'arrêt au plafond reste la règle des entraînements). */
  compterTout?: boolean;
}

function estEchantillonValide(objet: unknown): objet is EchantillonWebdev {
  const e = objet as EchantillonWebdev;
  return Boolean(
    e && typeof e.instruction === "string" && typeof e.output === "string"
      && e.instruction.length > 0 && e.output.length > 0
      && (e.language === "fr" || e.language === "en"),
  );
}

/**
 * Charge un échantillon représentatif du dataset web-dev.
 *
 * ARRÊT PRÉCOCE : le générateur du pack écrit les lignes dans un ORDRE
 * ALÉATOIRE UNIFORME (tirage seedé dans un espace combinatoire géant) — les
 * premières lignes du fichier SONT déjà un échantillon aléatoire du corpus.
 * La lecture s'arrête donc dès le plafond atteint : un entraînement ne lit
 * JAMAIS les millions de lignes, il en prélève un lot borné (mémoire et
 * temps). `compterTout: true` lit tout le fichier pour connaître le volume
 * réel (diagnostic, non nécessaire à l'entraînement).
 */
export async function chargerWebdev(
  opts: OptionsChargementWebdev = {},
): Promise<{ echantillons: EchantillonWebdev[]; totalLu: number; totalDataset: number | null; source: string }> {
  const plafond = opts.plafond ?? 60_000;
  const retenus: EchantillonWebdev[] = [];
  let totalVu = 0;
  let source = "";

  const traiter = (e: EchantillonWebdev) => {
    totalVu += 1;
    if (opts.langue && e.language !== opts.langue) return;
    if (retenus.length < plafond) retenus.push(e);
  };

  const conditionArret = (): boolean => !opts.compterTout && retenus.length >= plafond;

  for (const [chemin, gz] of [
    [CHEMIN_COMPLET_GZ, true],
    [CHEMIN_COMPLET_BRUT, false],
  ] as const) {
    try {
      const lu = await lireLignesFluxConditionnel(chemin, gz, traiter, conditionArret);
      if (lu > 0) {
        source = path.relative(process.cwd(), chemin);
        break;
      }
    } catch {
      // Dataset complet absent ou illisible : repli sur l'échantillon commis.
    }
  }

  if (retenus.length === 0) {
    // Repli garanti : l'échantillon commis au dépôt (toujours présent).
    const brut = await readFile(CHEMIN_ECHANTILLONS, "utf8");
    for (const ligne of brut.split("\n")) {
      const texte = ligne.trim();
      if (!texte) continue;
      try {
        const objet = JSON.parse(texte) as unknown;
        if (estEchantillonValide(objet)) traiter(objet);
      } catch {
        // Ligne corrompue ignorée.
      }
    }
    source = path.relative(process.cwd(), CHEMIN_ECHANTILLONS);
  }

  return {
    echantillons: retenus,
    totalLu: totalVu,
    totalDataset: opts.compterTout ? totalVu : null,
    source,
  };
}

/** Lecture conditionnelle : s'arrête dès que `arret()` renvoie true. */
async function lireLignesFluxConditionnel(
  chemin: string,
  gz: boolean,
  traiter: (echantillon: EchantillonWebdev) => void,
  arret: () => boolean,
): Promise<number> {
  const flux = createReadStream(chemin);
  const decodeur = gz ? flux.pipe(createGunzip()) : flux;
  const lecteur = readline.createInterface({ input: decodeur, crlfDelay: Infinity });
  let compteur = 0;
  lecteur.on("error", () => {
    /* flux corrompu : fin honnête, les lignes déjà lues restent exploitables. */
  });
  for await (const ligne of lecteur) {
    const texte = ligne.trim();
    if (!texte) continue;
    try {
      const objet = JSON.parse(texte) as unknown;
      if (estEchantillonValide(objet)) {
        traiter(objet);
        compteur += 1;
        if (arret()) {
          lecteur.close();
          flux.destroy();
          break;
        }
      }
    } catch {
      // Ligne corrompue : ignorée honnêtement (le reste reste exploitable).
    }
  }
  return compteur;
}

/**
 * Échantillons SNN { text, label } — le texte d'entraînement est constitué
 * des TOKENS SIGNATURES de l'instruction (texteEntrainement, max 6) : une
 * instruction brute de 200 caractères sature la zone d'entrée de 38 neurones
 * et tous les domaines produisent le même vecteur (accuracy au hasard —
 * cf. lib/neural/training/domaines.ts). Les échantillons sans aucun token
 * signature sont SAUTÉS (honnêteté : rien à apprendre d'un texte sans
 * vocabulaire propre au domaine).
 */
export function versEchantillonsSNN(
  echantillons: readonly EchantillonWebdev[],
  signatures: SignaturesDomaines,
): Array<{ text: string; label: string }> {
  const ancres = new Set(signatures.parLabel[LABEL_WEBDEV] ?? []);
  const samples: Array<{ text: string; label: string }> = [];
  for (const e of echantillons) {
    const texte = texteEntrainement(e.instruction, ancres);
    if (texte.length < 3) continue;
    samples.push({ text: texte, label: LABEL_WEBDEV });
  }
  return samples;
}

/** Paire conversationnelle pour le cortex langagier (thème dédié). */
export function versPairesCortex(
  echantillons: readonly EchantillonWebdev[],
  plafondReponse = 1400,
): Array<{ motif: string; reponse: string; theme: string }> {
  return echantillons.map((e) => ({
    // Motif COURT : la première phrase de l'instruction — le cortex matche
    // par tokens (même convention que construirePairesDomaines : une phrase
    // entière de 200 caractères serait trop spécifique pour être rappelée).
    motif: (e.instruction.split(/[.!?]/)[0] ?? e.instruction).trim(),
    // Réponse tronquée propre (fin de bloc) : le cortex apprend des
    // réponses conversationnelles compactes, le dataset complet reste
    // la référence documentaire.
    reponse: e.output.length <= plafondReponse
      ? e.output
      : e.output.slice(0, plafondReponse).replace(/\n[^\n]*$/, "") + " …",
    theme: `dev-web:${e.task_type}`,
  }));
}

/** Répartition honnête par type de tâche et par langue. */
export function repartitionWebdev(
  echantillons: readonly EchantillonWebdev[],
): { parTache: Record<string, number>; parLangue: Record<string, number> } {
  const parTache: Record<string, number> = {};
  const parLangue: Record<string, number> = {};
  for (const e of echantillons) {
    parTache[e.task_type] = (parTache[e.task_type] ?? 0) + 1;
    parLangue[e.language] = (parLangue[e.language] ?? 0) + 1;
  }
  return { parTache, parLangue };
}

/** Couverture lexicale : tokens distincts des instructions (signature SNN). */
export function couvertureLexicaleWebdev(
  echantillons: readonly EchantillonWebdev[],
): number {
  const tokens = new Set<string>();
  for (const e of echantillons) {
    for (const t of tokenize(e.instruction)) tokens.add(t);
  }
  return tokens.size;
}
