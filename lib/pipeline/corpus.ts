/**
 * CORPUS GLOBAL GEN3IA — périmètre de connaissances « auto-apprentissage ».
 *
 * Architecture (découplage asynchrone, cf. pipeline/README.md) :
 *   1. un daemon PM2 `gen3ia-pipeline` (process de FOND) scrape le web,
 *      nettoie les textes et les ajoute ATOMIQUEMENT (append-only) dans
 *      var/pipeline/output.jsonl (format JSON Lines, une ligne = un
 *      document auto-contenu, hash SHA-256 du contenu en identifiant) ;
 *   2. la route cron /api/cron/knowledge-ingest (process PRINCIPAL,
 *      protégée par CRON_SECRET) consomme ce fichier PAR OFFSET et
 *      ingère chaque document dans la base de connaissances (Firestore
 *      + index vectoriel Qdrant) sous un périmètre GLOBAL dédié ;
 *   3. searchKnowledge fusionne ce corpus global aux résultats
 *      personnels/org de chaque utilisateur (fail-soft) : gen3 répond
 *      ainsi avec des connaissances apprises en continu, citées par le
 *      pont connaissances (lib/neural/connaissances-pont.ts).
 *
 * Les deux mondes ne partagent QUE le fichier JSONL (stockage local
 * partagé) — jamais de mémoire, jamais de couplage direct : le daemon
 * peut scraper pendant que le serveur répond, sans jamais le ralentir.
 *
 * CE MODULE EST PUR (aucune I/O, aucun import serveur) : il porte les
 * règles de format, de qualité et de dédoublonnage partagées par les
 * deux côtés, et il est testé unitairement (corpus.test.ts).
 */

/** Périmètre global : userId synthétique propriétaire du corpus scrape. */
export const CORPUS_USER_ID = "gen3ia-corpus";

/** Périmètre global : projet synthétique unique du corpus. */
export const CORPUS_PROJECT_ID = "corpus-global";

/** Nom par défaut du fichier JSONL produit par le daemon. */
export const PIPELINE_OUTPUT_FILENAME = "output.jsonl";

/** Nom du fichier d'état d'ingestion (offset + empreintes vues). */
export const PIPELINE_STATE_FILENAME = "ingest-state.json";

/**
 * Longueur minimale d'un document en MOTS pour valoir l'ingestion
 * (au-delà des pages vides, menus, paginations, captchas).
 */
export const PIPELINE_MIN_WORDS = 100;

/**
 * Taille maximale du registre d'empreintes conservé dans l'état
 * (le daemon dédoublonne déjà par SHA-256 côté scraping ; ce second
 * registre est une ceinture de sécurité serveur). FIFO : les plus
 * anciennes empreintes sont retirées au-delà du plafond.
 */
export const PIPELINE_MAX_SEEN_HASHES = 20_000;

/** Format JSONL canonique écrit par le daemon (cf. pipeline/src/pipeline.ts). */
export interface PipelineRecord {
  /** SHA-256 hexadécimal du contenu nettoyé (identifiant de dédoublonnage). */
  id: string;
  url: string;
  title: string;
  content: string;
  scrapedAt: string;
  metadata?: {
    wordCount?: number;
    language?: string;
    httpStatus?: number;
  };
}

/** Résultat du filtrage qualité d'une ligne JSONL. */
export type RecordVerdict =
  | { ok: true; record: PipelineRecord }
  | { ok: false; reason: string };

/**
 * Vérifie qu'une chaîne est un SHA-256 hexadécimal valide (64 caractères).
 * Le champ `id` du protocole JSONL DOIT être l'empreinte du contenu :
 * c'est la clé de dédoublonnage bout en bout.
 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Nombre de mots d'un texte (même règle que le daemon : split espaces). */
export function compterMots(texte: string): number {
  const trimmed = texte.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Contrôle qualité d'un enregistrement JSONL avant ingestion :
 * format strict, empreinte valide, contenu suffisant, tailles bornées
 * (la limite dure 2 Mo est réappliquée par ingestKnowledgeDocument).
 */
export function validerRecord(candidat: unknown): RecordVerdict {
  if (typeof candidat !== "object" || candidat === null) {
    return { ok: false, reason: "ligne non-objet" };
  }
  const record = candidat as Partial<PipelineRecord>;
  if (!isSha256Hex(record.id)) {
    return { ok: false, reason: "id absent ou non SHA-256" };
  }
  if (typeof record.url !== "string" || !/^https?:\/\//i.test(record.url)) {
    return { ok: false, reason: "url absente ou non http(s)" };
  }
  if (typeof record.content !== "string" || record.content.trim().length === 0) {
    return { ok: false, reason: "contenu vide" };
  }
  if (Buffer.byteLength(record.content, "utf8") > 2_000_000) {
    return { ok: false, reason: "contenu > 2 Mo" };
  }
  const words = compterMots(record.content);
  if (words < PIPELINE_MIN_WORDS) {
    return { ok: false, reason: `contenu trop court (${words} mots)` };
  }
  if (record.scrapedAt !== undefined && typeof record.scrapedAt !== "string") {
    return { ok: false, reason: "scrapedAt non ISO" };
  }
  return {
    ok: true,
    record: {
      id: record.id,
      url: record.url,
      title:
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim().slice(0, 300)
          : record.url,
      content: record.content,
      scrapedAt:
        typeof record.scrapedAt === "string" ? record.scrapedAt : "",
      metadata:
        record.metadata && typeof record.metadata === "object"
          ? record.metadata
          : {},
    },
  };
}

/** État d'ingestion persisté dans var/pipeline/ingest-state.json. */
export interface IngestState {
  /** Octet offset de lecture du JSONL (prochaine position à consommer). */
  offset: number;
  /** Empreintes SHA-256 déjà ingérées (dédoublonnage serveur, FIFO plafonné). */
  seenHashes: string[];
  /** Date ISO de la dernière mise à jour de l'état. */
  updatedAt: string;
}

export function nouvelIngestState(): IngestState {
  return { offset: 0, seenHashes: [], updatedAt: "" };
}

/**
 * Parse l'état depuis un contenu JSON brut (fichier absent/corrompu =
 * état neuf — l'ingestion repart du début du fichier, le dédoublonnage
 * par empreinte empêche toute double ingestion réelle).
 */
export function parserIngestState(brut: string | null): IngestState {
  if (!brut) return nouvelIngestState();
  try {
    const data = JSON.parse(brut) as Partial<IngestState>;
    if (typeof data.offset !== "number" || !Number.isFinite(data.offset) || data.offset < 0) {
      return nouvelIngestState();
    }
    if (!Array.isArray(data.seenHashes)) return nouvelIngestState();
    return {
      offset: Math.floor(data.offset),
      seenHashes: data.seenHashes.filter(isSha256Hex),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    };
  } catch {
    return nouvelIngestState();
  }
}

/** Ajoute une empreinte au registre (FIFO plafonné, sans doublon). */
export function enregistrerHash(state: IngestState, hash: string): IngestState {
  const restants = state.seenHashes.filter((h) => h !== hash);
  restants.push(hash);
  const tronque =
    restants.length > PIPELINE_MAX_SEEN_HASHES
      ? restants.slice(restants.length - PIPELINE_MAX_SEEN_HASHES)
      : restants;
  return { ...state, seenHashes: tronque };
}

/**
 * Un enregistrement consommé avec la position APRÈS sa ligne — l'ingestion
 * avance l'offset document par document : si le plafond de sécurité
 * interrompt le passage, les documents suivants restent en place pour le
 * prochain cron (aucune perte, aucune re-ingestion).
 */
export interface ConsumedRecord {
  record: PipelineRecord;
  /** Offset absolu juste après la ligne de cet enregistrement. */
  endOffset: number;
}

/**
 * Lot consommé depuis le JSONL : le nouvel offset s'arrête TOUJOURS à la
 * fin de la dernière ligne COMPLÈTE (terminée par \n) — une ligne en
 * cours d'écriture par le daemon ne sera jamais consommée à moitié
 * (garantie de lecture atomique ligne à ligne, cf. architecture).
 */
export interface ConsumedBatch {
  records: ConsumedRecord[];
  /** Offset sûr = position après la dernière ligne complète analysée. */
  nextOffset: number;
  failures: Array<{ url: string; reason: string }>;
  duplicates: number;
}

/**
 * Analyse un bloc de texte JSONL brut : découpe en lignes complètes,
 * valide chaque enregistrement, dédoublonne contre le registre d'état.
 * TOUS les offsets sont exprimés en OCTETS (les positions de lecture fs
 * sont des octets ; un calcul en caractères UTF-16 dériverait dès le
 * premier accent). Renvoie aussi l'offset AVANT la dernière ligne
 * incomplète.
 */
export function consommerJsonl(
  bloc: string,
  offsetDebut: number,
  seenHashes: ReadonlySet<string>,
): ConsumedBatch {
  const records: ConsumedRecord[] = [];
  const failures: ConsumedBatch["failures"] = [];
  let duplicates = 0;
  const vus = new Set<string>(seenHashes);
  // Cumul en octets depuis le début du bloc (ligne + son \n).
  let cumule = 0;
  let lastCompleteEnd = 0;

  const lignes = bloc.split("\n");
  for (let i = 0; i < lignes.length; i += 1) {
    const ligne = lignes[i];
    const isLast = i === lignes.length - 1;

    if (isLast) {
      // Dernier segment : complet uniquement si le bloc se termine par
      // \n (segment vide final) — sinon écriture en cours du daemon,
      // on ne la consomme PAS (offset arrêté avant).
      if (ligne.length === 0 && bloc.endsWith("\n")) {
        lastCompleteEnd = cumule;
      }
      break;
    }

    if (ligne.trim().length > 0) {
      try {
        const verdict = validerRecord(JSON.parse(ligne));
        if (verdict.ok) {
          if (vus.has(verdict.record.id)) {
            duplicates += 1;
          } else {
            vus.add(verdict.record.id);
            records.push({
              record: verdict.record,
              endOffset: offsetDebut + cumule + Buffer.byteLength(ligne, "utf-8") + 1,
            });
          }
        } else {
          failures.push({ url: "", reason: verdict.reason });
        }
      } catch {
        failures.push({ url: "", reason: "JSON invalide (ligne ignorée)" });
      }
    }
    cumule += Buffer.byteLength(ligne, "utf-8") + 1;
    lastCompleteEnd = cumule;
  }

  return {
    records,
    nextOffset: offsetDebut + lastCompleteEnd,
    failures,
    duplicates,
  };
}
