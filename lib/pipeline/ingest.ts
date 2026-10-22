import "server-only";

import { promises as fsp } from "node:fs";
import { join } from "node:path";

import {
  ConsumedBatch,
  IngestState,
  PIPELINE_OUTPUT_FILENAME,
  PIPELINE_STATE_FILENAME,
  consommerJsonl,
  enregistrerHash,
  parserIngestState,
} from "./corpus";

/**
 * INGESTION DU CORPUS — côté serveur (process principal Next.js).
 *
 * Consomme le JSONL produit par le daemon de scraping PAR OCTET OFFSET :
 *   · lecture à partir de state.offset (jamais de relecture complète —
 *     le fichier peut croître indéfiniment sans coûter plus cher) ;
 *   · l'offset n'avance que sur des lignes COMPLÈTES (le daemon écrit en
 *     append-only : une ligne partielle est laissée au prochain passage) ;
 *   · chaque document passe par ingestKnowledgeDocument (Firestore +
 *     indexation vectorielle Qdrant) sous le périmètre global CORPUS ;
 *   · l'état est réécrit ATOMIQUEMENT (.tmp unique + rename) après CHAQUE
 *     document ingéré : un crash au milieu du lot ne re-ingère jamais
 *     deux fois le même document ;
 *   · un échec d'ingestion n'arrête PAS le lot (best-effort) — l'offset
 *     avance quand même (le document est journalisé et perdu pour
 *     l'ingestion, mais JAMAIS de boucle d'échec infinie) ;
 *   · plafonds stricts : MAX_DOCS documents et TIMEBOX_MS par passage
 *     (le serveur utilisateur reste prioritaire sur CPU/mémoire/RAM).
 *
 * Répertoire de données partagé avec le daemon : PIPELINE_DATA_DIR
 * (défaut var/pipeline, hors git). Sur le VPS les deux process tournent
 * sur la même machine (cwd /opt/gen3ia) — le « stockage local partagé »
 * de l'architecture découplée.
 */

/** Plafond de documents ingérés par passage (protection ressources). */
export const PIPELINE_MAX_DOCS_PER_RUN = Number(
  process.env.PIPELINE_INGEST_MAX_DOCS ?? "60",
);

/** Timebox du passage complet (ms) — la route cron a maxDuration 300 s. */
export const PIPELINE_INGEST_TIMEBOX_MS = 240_000;

/** Répertoire de données par défaut (relatif au cwd du serveur). */
export function pipelineDataDir(): string {
  return process.env.PIPELINE_DATA_DIR
    ? process.env.PIPELINE_DATA_DIR
    : join(process.cwd(), "var", "pipeline");
}

/**
 * MUTEX DE L'INGESTION — chaîne de promesses : chaque runPipelineIngest
 * attend la fin du précédent AVANT de démarrer (deux passages concurrents
 * — cron + déclencheur daemon — ne consomment jamais le même fichier en
 * même temps ; le second constate un offset déjà avancé = no-op propre).
 */
let fileDIngestion: Promise<IngestRunResult> = Promise.resolve({
  ok: true,
  offset: 0,
  ingested: 0,
  duplicates: 0,
  skipped: 0,
  failures: [],
  truncated: false,
});

/** Résultat d'un passage d'ingestion (données 100 % réelles). */
export interface IngestRunResult {
  ok: boolean;
  /** Offset du fichier APRES le passage. */
  offset: number;
  /** Documents réellement ingérés (Firestore + Qdrant). */
  ingested: number;
  /** Empreintes déjà vues (dédoublonnage serveur). */
  duplicates: number;
  /** Lignes écartées par contrôle qualité. */
  skipped: number;
  failures: Array<{ url: string; reason: string }>;
  /** True si le plafond de documents/timebox a interrompu le passage. */
  truncated: boolean;
  error?: string;
}

/** Écriture ATOMIQUE du fichier d'état (tmp unique + rename, mutex interne). */
let fileDEtat: Promise<void> = Promise.resolve();

async function ecrireEtatAtomique(statePath: string, state: IngestState): Promise<void> {
  const run = async (): Promise<void> => {
    const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(
      { ...state, updatedAt: new Date().toISOString() },
      null,
      2,
    );
    await fsp.writeFile(tmp, payload, "utf-8");
    await fsp.rename(tmp, statePath);
  };
  const precedent = fileDEtat;
  fileDEtat = (async () => {
    await precedent.catch(() => undefined);
    await run();
  })();
  return fileDEtat;
}

/** Résultat de lecture du JSONL depuis l'offset d'état. */
interface LectureJsonl {
  bloc: string;
  tailleFichier: number;
}

async function lireDepuisOffset(
  fichier: string,
  offset: number,
): Promise<LectureJsonl> {
  const handle = await fsp.open(fichier, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= offset) return { bloc: "", tailleFichier: stat.size };
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return { bloc: buffer.toString("utf-8"), tailleFichier: stat.size };
  } finally {
    await handle.close();
  }
}

export interface RunPipelineIngestOptions {
  /** Injection de la fonction d'ingestion (tests). Défaut : lib/knowledge. */
  ingester?: (record: { title: string; content: string; url: string }) => Promise<void>;
  /** Plafond de documents (tests). */
  maxDocs?: number;
}

/**
 * Passage d'ingestion complet. Sérialisé par le mutex interne ; ne lève
 * JAMAIS (le résultat porte ok/error pour la route cron).
 */
export async function runPipelineIngest(
  options: RunPipelineIngestOptions = {},
): Promise<IngestRunResult> {
  const precedent = fileDIngestion;
  // Le run ne DÉMARRE qu'après la fin du précédent (sérialisation réelle :
  // la fonction interne n'est invoquée que dans le .then).
  fileDIngestion = precedent
    .catch(() => undefined)
    .then(() => runPipelineIngestInterne(options));
  return fileDIngestion;
}

async function runPipelineIngestInterne(
  options: RunPipelineIngestOptions,
): Promise<IngestRunResult> {
  const dataDir = pipelineDataDir();
  const fichier = join(dataDir, PIPELINE_OUTPUT_FILENAME);
  const statePath = join(dataDir, PIPELINE_STATE_FILENAME);
  const maxDocs = options.maxDocs ?? PIPELINE_MAX_DOCS_PER_RUN;
  const debut = Date.now();

  const echec = (error: string): IngestRunResult => ({
    ok: false,
    offset: 0,
    ingested: 0,
    duplicates: 0,
    skipped: 0,
    failures: [],
    truncated: false,
    error,
  });

  try {
    // 1. État courant (fichier absent/corrompu = état neuf, cf. corpus.ts).
    let brutEtat: string | null = null;
    try {
      brutEtat = await fsp.readFile(statePath, "utf-8");
    } catch {
      brutEtat = null;
    }
    const state = parserIngestState(brutEtat);

    // 2. Lecture du JSONL depuis l'offset.
    let lecture: LectureJsonl;
    try {
      lecture = await lireDepuisOffset(fichier, state.offset);
    } catch {
      // Fichier absent : le daemon n'a encore rien produit — no-op propre.
      return {
        ok: true,
        offset: state.offset,
        ingested: 0,
        duplicates: 0,
        skipped: 0,
        failures: [],
        truncated: false,
      };
    }

    // Rotation/troncation détectée (fichier plus court que l'offset) :
    // repartir du début, le registre d'empreintes protège des doublons.
    // IMPORTANT : relire DEPUIS 0 (la première lecture à partir de
    // l'offset obsolète a rendu un bloc vide — size <= offset).
    const rotation = lecture.tailleFichier < state.offset;
    if (rotation) {
      lecture = await lireDepuisOffset(fichier, 0);
    }
    const offsetDebut = rotation ? 0 : state.offset;

    // 3. Consommation (lignes complètes uniquement) + dédoublonnage.
    const registre = new Set(state.seenHashes);
    const lot: ConsumedBatch = consommerJsonl(lecture.bloc, offsetDebut, registre);

    // 4. Ingération plafonnée + timeboxée, état persisté après CHAQUE doc.
    let stateCourant: IngestState = rotation
      ? { ...state, offset: 0 }
      : state;
    let ingested = 0;
    let truncated = false;
    const failures = [...lot.failures];

    const { ingestKnowledgeDocument } = await import("@/lib/knowledge/ingestion");
    const { CORPUS_PROJECT_ID, CORPUS_USER_ID } = await import("./corpus");

    const ingesterDefaut = async (record: { title: string; content: string; url: string }): Promise<void> => {
      await ingestKnowledgeDocument({
        userId: CORPUS_USER_ID,
        projectId: CORPUS_PROJECT_ID,
        name: record.title || record.url,
        mimeType: "text/plain",
        text: record.content,
        source: "url",
        storagePath: undefined,
      });
    };
    const ingester = options.ingester ?? ingesterDefaut;

    for (const consomme of lot.records) {
      const record = consomme.record;
      if (ingested >= maxDocs || Date.now() - debut > PIPELINE_INGEST_TIMEBOX_MS) {
        // Plafond atteint : l'offset s'arrête À CET ENREGISTREMENT —
        // les suivants restent en place pour le prochain passage.
        truncated = true;
        break;
      }
      try {
        await ingester({ title: record.title, content: record.content, url: record.url });
        ingested += 1;
        stateCourant = enregistrerHash(stateCourant, record.id);
      } catch (error) {
        failures.push({
          url: record.url,
          reason: error instanceof Error ? error.message : "ingestion échouée",
        });
      }
      // L'offset avance document par document (ingéré OU échoué) :
      // pas de boucle d'échec infinie, aucune re-ingestion après crash.
      stateCourant = { ...stateCourant, offset: consomme.endOffset };
      await ecrireEtatAtomique(statePath, stateCourant);
    }

    if (!truncated) {
      // Passage arrivé au bout du lot (ou aucun document nouveau) :
      // aligner l'offset sur la fin des lignes complètes lues
      // (avale les lignes invalides/dédoublonnées sans ré-ingestion).
      stateCourant = { ...stateCourant, offset: Math.max(stateCourant.offset, lot.nextOffset) };
      await ecrireEtatAtomique(statePath, stateCourant);
    }

    return {
      ok: true,
      offset: stateCourant.offset,
      ingested,
      duplicates: lot.duplicates,
      skipped: lot.failures.length,
      failures,
      truncated,
    };
  } catch (error) {
    return echec(error instanceof Error ? error.message : "ingestion échouée");
  }
}
