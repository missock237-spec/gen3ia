import "server-only";

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";

/**
 * REGISTRE DE MODÈLES LOCAL (Pilier 2 — MLOps industrialisé, transposé
 * localement ; migration Vertex AI Model Registry en Phase 3 — cf.
 * docs/mlops.md).
 *
 * Rôle : inventaire versionné des artefacts neuronaux avec lignage, canaux
 * et pointeur de production. Stockage : var/neural/registry/<modelId>/
 *   - <version>.json     — manifeste de la version ;
 *   - production.json    — pointeur du canal de production (fait foi).
 * var/ est HORS git (.gitignore, entrée « État neuronal persistant »).
 *
 * RÈGLE D'OR : les binaires ne sont JAMAIS copiés dans le registre — seuls
 * des JSON de métadonnées vivent ici. Un artefact est RÉFÉRENCÉ (chemin
 * local var/neural/…, assets/… ou URL R2 https://…) avec son empreinte
 * sha256 et sa taille.
 *
 * Garanties :
 *  - VALIDATION STRICTE à l'enregistrement (ErreurRegistre, messages FR
 *    actionnables, code machine exploitable) ;
 *  - écritures ATOMIQUES (fichier .tmp unique pid+uuid → rename — même
 *    convention que lib/neural/training/persistence.ts) : un crash ne
 *    peut jamais laisser un manifeste ou un pointeur tronqué ;
 *  - IDEMPOTENCE : ré-enregistrer un manifeste STRICTEMENT identique est
 *    un no-op ; un contenu différent pour une même version est refusé
 *    (incrémenter la version) ;
 *  - le POINTEUR production.json fait foi pour la version servie :
 *    latest(modelId, "production") le résout en priorité, et le rollback
 *    n'est qu'un déplacement de pointeur (aucune suppression, aucune
 *    réécriture d'historique).
 */

/** Racine par défaut du registre (var/ est hors git). */
export const REGISTRE_RACINE_DEFAUT = join(
  process.cwd(),
  "var",
  "neural",
  "registry",
);

/** Canaux de diffusion d'une version de modèle. */
export type CanalModele = "experimental" | "production";

/** Provenance déclarée d'une version (chaîne de lignage). */
export type SourceLineage = "training-worker" | "manuel" | "pipeline";

/** Référence d'un artefact (JAMAIS le binaire lui-même — chemin ou URL). */
export interface ArtefactModele {
  /** Chemin local (var/neural/…, assets/…) ou URL R2 (https://…). */
  chemin: string;
  /** Empreinte SHA-256 hexadécimale (64 caractères) du binaire. */
  sha256: string;
  /** Taille du binaire en octets. */
  bytes: number;
}

/** Jeu de données référencé par une version. */
export interface DatasetModele {
  /** Nom lisible du jeu (corpus-llms, amorcage-canonique…). */
  nom: string;
  /** Chemin (public/llms.txt) OU empreinte sha256 du contenu. */
  reference: string;
  /** Nombre d'échantillons retenus de ce jeu. */
  echantillons: number;
}

/** Métrique d'évaluation d'une version (seuilMin = plancher d'acceptation). */
export interface MetriqueModele {
  nom: string;
  valeur: number;
  /** Plancher déclaré : une version sous ce plancher ne peut être promue. */
  seuilMin?: number;
}

/** Lignage d'une version (d'où elle vient). */
export interface LignageModele {
  /** Version parente dont celle-ci dérive (absente pour une racine). */
  parentVersion?: string;
  /** Mécanisme qui a produit la version. */
  source: SourceLineage;
}

/** Manifeste complet d'une version de modèle (schéma docs/mlops.md). */
export interface ManifestModele {
  /** Identifiant stable du modèle (kebab-case). */
  modelId: string;
  /** Version semver-like (X.Y.Z) ou horodatage (AAAAMMJJTHHMMSSZ). */
  version: string;
  /** Date ISO de création de la version. */
  createdAt: string;
  /** SHA git du code (7..40 hex) ; 0000000 = sha indisponible. */
  gitSha: string;
  /** Auteur/mécanisme déclaratif (ex. « pipeline-mlops », « opérateur »). */
  auteur: string;
  artefact: ArtefactModele;
  datasets: DatasetModele[];
  /** Objet libre : hyperparamètres, distribution d'entraînement… */
  hyperparams: Record<string, unknown>;
  metrics: MetriqueModele[];
  lineage: LignageModele;
  channel: CanalModele;
}

/** Pointeur du canal de production (fichier production.json). */
export interface PointeurProduction {
  modelId: string;
  version: string;
  /** Date ISO de la promotion ou du rollback. */
  promuLe: string;
  /** Opération à l'origine du pointage courant. */
  origine: "promotion" | "rollback";
}

/** Erreur de registre : message FR actionnable + code machine. */
export class ErreurRegistre extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MANIFESTE_INVALIDE"
      | "VERSION_EXISTANTE"
      | "INTROUVABLE"
      | "CANAL_INVALIDE",
  ) {
    super(message);
    this.name = "ErreurRegistre";
  }
}

/* ------------------------------------------------------------------ */
/* Formats acceptés                                                     */
/* ------------------------------------------------------------------ */

/** modelId : kebab-case filesystem-safe (2..63 caractères). */
const RE_MODEL_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** version : semver-like X.Y.Z (+ suffixe -prerelease/+build optionnel)
 *  OU horodatage UTC compact AAAAMMJJTHHMMSSZ. */
const RE_VERSION =
  /^(?:\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|\d{8}T\d{6}Z)$/;
/** sha256 : 64 caractères hexadécimaux minuscules. */
const RE_SHA256 = /^[0-9a-f]{64}$/;
/** gitSha : SHA court (7) à complet (40), hexadécimal minuscule. */
const RE_GIT_SHA = /^[0-9a-f]{7,40}$/;

/* ------------------------------------------------------------------ */
/* Validation stricte                                                   */
/* ------------------------------------------------------------------ */

function exigerString(valeur: unknown, champ: string): string {
  if (typeof valeur !== "string" || valeur.trim().length === 0) {
    throw new ErreurRegistre(
      `Champ « ${champ} » manquant ou vide.`,
      "MANIFESTE_INVALIDE",
    );
  }
  return valeur;
}

function exigerEntierPositif(valeur: unknown, champ: string): number {
  if (typeof valeur !== "number" || !Number.isInteger(valeur) || valeur < 0) {
    throw new ErreurRegistre(
      `Champ « ${champ} » doit être un entier ≥ 0 (reçu : ${String(valeur)}).`,
      "MANIFESTE_INVALIDE",
    );
  }
  return valeur;
}

function exigerNombreFini(valeur: unknown, champ: string): number {
  if (typeof valeur !== "number" || !Number.isFinite(valeur)) {
    throw new ErreurRegistre(
      `Champ « ${champ} » doit être un nombre fini (reçu : ${String(valeur)}).`,
      "MANIFESTE_INVALIDE",
    );
  }
  return valeur;
}

/**
 * Valide strictement un manifeste et retourne une copie NORMALISÉE
 * (champs par défaut appliqués, ordre de sérialisation stable — la
 * comparaison d'idempotence de register() repose dessus).
 */
export function validerManifest(brut: ManifestModele): ManifestModele {
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) {
    throw new ErreurRegistre(
      "Manifeste invalide : un objet JSON est attendu.",
      "MANIFESTE_INVALIDE",
    );
  }

  const modelId = exigerString(brut.modelId, "modelId");
  if (!RE_MODEL_ID.test(modelId)) {
    throw new ErreurRegistre(
      `Champ « modelId » invalide (« ${modelId} ») : kebab-case attendu (ex. gen3-cortex-v2).`,
      "MANIFESTE_INVALIDE",
    );
  }

  const version = exigerString(brut.version, "version");
  if (!RE_VERSION.test(version)) {
    throw new ErreurRegistre(
      `Champ « version » invalide (« ${version} ») : X.Y.Z ou AAAAMMJJTHHMMSSZ attendu.`,
      "MANIFESTE_INVALIDE",
    );
  }

  const createdAt = exigerString(brut.createdAt, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new ErreurRegistre(
      `Champ « createdAt » invalide (« ${createdAt} ») : date ISO attendue.`,
      "MANIFESTE_INVALIDE",
    );
  }

  const gitSha = exigerString(brut.gitSha, "gitSha");
  if (!RE_GIT_SHA.test(gitSha)) {
    throw new ErreurRegistre(
      `Champ « gitSha » invalide (« ${gitSha} ») : 7 à 40 caractères hexadécimaux attendus (0000000 si indisponible).`,
      "MANIFESTE_INVALIDE",
    );
  }

  const auteur = exigerString(brut.auteur, "auteur");

  const artefactBrut = brut.artefact;
  if (typeof artefactBrut !== "object" || artefactBrut === null) {
    throw new ErreurRegistre(
      "Champ « artefact » manquant : { chemin, sha256, bytes } attendu.",
      "MANIFESTE_INVALIDE",
    );
  }
  const artefact: ArtefactModele = {
    chemin: exigerString(artefactBrut.chemin, "artefact.chemin"),
    sha256: exigerString(artefactBrut.sha256, "artefact.sha256"),
    bytes: exigerEntierPositif(artefactBrut.bytes, "artefact.bytes"),
  };
  if (!RE_SHA256.test(artefact.sha256)) {
    throw new ErreurRegistre(
      "Champ « artefact.sha256 » invalide : empreinte hexadécimale de 64 caractères attendue (node:crypto createHash('sha256')).",
      "MANIFESTE_INVALIDE",
    );
  }

  const datasets: DatasetModele[] = [];
  if (brut.datasets !== undefined) {
    if (!Array.isArray(brut.datasets)) {
      throw new ErreurRegistre(
        "Champ « datasets » invalide : un tableau est attendu.",
        "MANIFESTE_INVALIDE",
      );
    }
    for (const jeu of brut.datasets) {
      if (typeof jeu !== "object" || jeu === null) {
        throw new ErreurRegistre(
          "Champ « datasets » invalide : chaque jeu doit être un objet { nom, reference, echantillons }.",
          "MANIFESTE_INVALIDE",
        );
      }
      datasets.push({
        nom: exigerString(jeu.nom, "datasets[].nom"),
        reference: exigerString(jeu.reference, "datasets[].reference"),
        echantillons: exigerEntierPositif(
          jeu.echantillons,
          "datasets[].echantillons",
        ),
      });
    }
  }

  let hyperparams: Record<string, unknown> = {};
  if (brut.hyperparams !== undefined) {
    if (
      typeof brut.hyperparams !== "object" ||
      brut.hyperparams === null ||
      Array.isArray(brut.hyperparams)
    ) {
      throw new ErreurRegistre(
        "Champ « hyperparams » invalide : un objet libre est attendu.",
        "MANIFESTE_INVALIDE",
      );
    }
    hyperparams = { ...brut.hyperparams };
  }

  const metrics: MetriqueModele[] = [];
  if (brut.metrics !== undefined) {
    if (!Array.isArray(brut.metrics)) {
      throw new ErreurRegistre(
        "Champ « metrics » invalide : un tableau est attendu.",
        "MANIFESTE_INVALIDE",
      );
    }
    for (const metrique of brut.metrics) {
      if (typeof metrique !== "object" || metrique === null) {
        throw new ErreurRegistre(
          "Champ « metrics » invalide : chaque métrique doit être un objet { nom, valeur, seuilMin? }.",
          "MANIFESTE_INVALIDE",
        );
      }
      const normalisee: MetriqueModele = {
        nom: exigerString(metrique.nom, "metrics[].nom"),
        valeur: exigerNombreFini(metrique.valeur, "metrics[].valeur"),
      };
      if (metrique.seuilMin !== undefined) {
        normalisee.seuilMin = exigerNombreFini(
          metrique.seuilMin,
          "metrics[].seuilMin",
        );
      }
      metrics.push(normalisee);
    }
  }

  const lignageBrut = brut.lineage;
  if (typeof lignageBrut !== "object" || lignageBrut === null) {
    throw new ErreurRegistre(
      "Champ « lineage » manquant : { source, parentVersion? } attendu.",
      "MANIFESTE_INVALIDE",
    );
  }
  if (
    lignageBrut.source !== "training-worker" &&
    lignageBrut.source !== "manuel" &&
    lignageBrut.source !== "pipeline"
  ) {
    throw new ErreurRegistre(
      `Champ « lineage.source » invalide (« ${String(lignageBrut.source)} ») : training-worker | manuel | pipeline attendu.`,
      "MANIFESTE_INVALIDE",
    );
  }
  const lineage: LignageModele = {
    source: lignageBrut.source,
  };
  if (lignageBrut.parentVersion !== undefined) {
    const parent = exigerString(
      lignageBrut.parentVersion,
      "lineage.parentVersion",
    );
    if (!RE_VERSION.test(parent)) {
      throw new ErreurRegistre(
        `Champ « lineage.parentVersion » invalide (« ${parent} »).`,
        "MANIFESTE_INVALIDE",
      );
    }
    lineage.parentVersion = parent;
  }

  if (brut.channel !== "experimental" && brut.channel !== "production") {
    throw new ErreurRegistre(
      `Champ « channel » invalide (« ${String(brut.channel)} ») : experimental | production attendu.`,
      "MANIFESTE_INVALIDE",
    );
  }
  const channel: CanalModele = brut.channel;

  // Ordre de construction FIXE : deux appels register() avec le même
  // manifeste produisent la même sérialisation (idempotence).
  return {
    modelId,
    version,
    createdAt,
    gitSha,
    auteur,
    artefact,
    datasets,
    hyperparams,
    metrics,
    lineage,
    channel,
  };
}

/* ------------------------------------------------------------------ */
/* Empreinte d'artefact (sha256 via node:crypto)                        */
/* ------------------------------------------------------------------ */

/**
 * Calcule l'empreinte { sha256, bytes } d'un fichier artefact local —
 * à utiliser par les producteurs de manifestes (pipeline, scripts) pour
 * remplir artefact.sha256 / artefact.bytes. Le registre lui-même ne lit
 * JAMAIS les binaires (il n'en conserve que les références).
 */
export async function empreinteArtefact(
  chemin: string,
): Promise<{ sha256: string; bytes: number }> {
  const { createHash } = await import("node:crypto");
  const contenu = await fsp.readFile(chemin);
  return {
    sha256: createHash("sha256").update(contenu).digest("hex"),
    bytes: contenu.byteLength,
  };
}

/* ------------------------------------------------------------------ */
/* Registre                                                             */
/* ------------------------------------------------------------------ */

/** Fichier de list()/get() non reconnu (ignoré avec avertissement). */
function avertirFichierIgnore(chemin: string, cause: string): void {
  console.warn(`[MLOPS-REGISTRY] Fichier ignoré (${chemin}) : ${cause}`);
}

export class RegistreModeles {
  constructor(private readonly racine: string = REGISTRE_RACINE_DEFAUT) {}

  /** Dossier du modèle. */
  private dossierModel(modelId: string): string {
    return join(this.racine, modelId);
  }

  /** Chemin du manifeste d'une version. */
  private cheminVersion(modelId: string, version: string): string {
    return join(this.racine, modelId, `${version}.json`);
  }

  /** Chemin du pointeur de production. */
  private cheminPointeur(modelId: string): string {
    return join(this.racine, modelId, "production.json");
  }

  /**
   * Écriture ATOMIQUE (mkdir du parent + .tmp unique pid+uuid → rename,
   * purge du .tmp en cas d'échec) — un lecteur concurrent ne voit jamais
   * un fichier partiel.
   */
  private async ecrireAtomique(
    chemin: string,
    contenu: string,
  ): Promise<void> {
    await fsp.mkdir(join(chemin, ".."), { recursive: true });
    const tmp = `${chemin}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, contenu, "utf8");
      await fsp.rename(tmp, chemin);
    } catch (erreur: unknown) {
      try {
        await fsp.unlink(tmp);
      } catch {
        // Déjà parti ou jamais créé — rien à faire.
      }
      throw erreur;
    }
  }

  /** Lecture JSON tolérante : null si absent (l'appelant gère la suite). */
  private async lireJson(chemin: string): Promise<unknown | null> {
    try {
      const brut = await fsp.readFile(chemin, "utf8");
      return JSON.parse(brut) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * Enregistre une version (validation stricte + écriture atomique).
   * Idempotent si le manifeste existant est STRICTEMENT identique ;
   * refuse un contenu différent pour la même version (VERSION_EXISTANTE).
   */
  async register(manifest: ManifestModele): Promise<ManifestModele> {
    const normalise = validerManifest(manifest);
    const chemin = this.cheminVersion(normalise.modelId, normalise.version);
    const existant = await this.lireJson(chemin);
    if (existant !== null) {
      if (JSON.stringify(existant) === JSON.stringify(normalise)) {
        return normalise;
      }
      throw new ErreurRegistre(
        `La version ${normalise.version} de « ${normalise.modelId} » existe déjà avec un contenu différent — incrémentez la version (l'historique du registre est immuable).`,
        "VERSION_EXISTANTE",
      );
    }
    await this.ecrireAtomique(chemin, JSON.stringify(normalise, null, 2));
    return normalise;
  }

  /**
   * Liste les versions d'un modèle, triées de la plus récente à la plus
   * ancienne (createdAt desc, version desc en cas d'égalité).
   * Les fichiers illisibles sont ignorés avec avertissement.
   */
  async list(modelId: string): Promise<ManifestModele[]> {
    const dossier = this.dossierModel(modelId);
    let noms: string[];
    try {
      noms = await fsp.readdir(dossier);
    } catch {
      return [];
    }
    const manifestes: ManifestModele[] = [];
    for (const nom of noms) {
      if (!nom.endsWith(".json") || nom === "production.json") continue;
      const brut = await this.lireJson(join(dossier, nom));
      try {
        manifestes.push(validerManifest(brut as ManifestModele));
      } catch (erreur: unknown) {
        avertirFichierIgnore(
          join(dossier, nom),
          erreur instanceof Error ? erreur.message : "manifeste invalide",
        );
      }
    }
    manifestes.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.version < b.version ? 1 : -1;
    });
    return manifestes;
  }

  /** Lit une version précise. null si absente ou illisible. */
  async get(modelId: string, version: string): Promise<ManifestModele | null> {
    const brut = await this.lireJson(this.cheminVersion(modelId, version));
    if (brut === null) return null;
    try {
      return validerManifest(brut as ManifestModele);
    } catch (erreur: unknown) {
      avertirFichierIgnore(
        this.cheminVersion(modelId, version),
        erreur instanceof Error ? erreur.message : "manifeste invalide",
      );
      return null;
    }
  }

  /**
   * Pointeur de production brut. null si absent ou illisible.
   * Le pointeur FAIT FOI : c'est la version effectivement servie.
   */
  async pointeurProduction(
    modelId: string,
  ): Promise<PointeurProduction | null> {
    const brut = (await this.lireJson(
      this.cheminPointeur(modelId),
    )) as Partial<PointeurProduction> | null;
    if (
      brut === null ||
      typeof brut !== "object" ||
      typeof brut.version !== "string" ||
      brut.version.length === 0
    ) {
      return null;
    }
    return {
      modelId,
      version: brut.version,
      promuLe:
        typeof brut.promuLe === "string"
          ? brut.promuLe
          : new Date(0).toISOString(),
      origine: brut.origine === "rollback" ? "rollback" : "promotion",
    };
  }

  /**
   * Dernière version d'un canal :
   *  - « production » : le POINTEUR production.json est résolu en priorité
   *    (c'est lui qui suit les rollbacks) ; repli sur le balayage du champ
   *    channel pour les registres antérieurs au pointeur ;
   *  - « experimental » : balayage du champ channel (versions quarantainées
   *    ou en cours d'évaluation), du plus récent au plus ancien.
   */
  async latest(
    modelId: string,
    canal: CanalModele,
  ): Promise<ManifestModele | null> {
    if (canal === "production") {
      const pointeur = await this.pointeurProduction(modelId);
      if (pointeur) {
        const manifeste = await this.get(modelId, pointeur.version);
        if (manifeste) return manifeste;
      }
    }
    const tous = await this.list(modelId);
    return tous.find((m) => m.channel === canal) ?? null;
  }

  /**
   * Promeut une version vers un canal.
   *  - « production » : le canal du manifeste est mis à jour ET le pointeur
   *    production.json est réécrit ATOMIQUEMENT (origine « promotion ») ;
   *  - « experimental » : simple remise du canal du manifeste (démotion
   *    explicite) — aucun pointeur n'est touché (retour null).
   * Le rollback s'exprime avec rollback() (déplacement de pointeur seul)
   * ou en promouvant une ancienne version.
   */
  async promouvoir(
    modelId: string,
    version: string,
    canal: CanalModele = "production",
  ): Promise<PointeurProduction | null> {
    const manifeste = await this.get(modelId, version);
    if (!manifeste) {
      throw new ErreurRegistre(
        `Version ${version} introuvable pour « ${modelId} » — impossible de promouvoir.`,
        "INTROUVABLE",
      );
    }
    if (manifeste.channel !== canal) {
      const misAJour = { ...manifeste, channel: canal };
      await this.ecrireAtomique(
        this.cheminVersion(modelId, version),
        JSON.stringify(misAJour, null, 2),
      );
    }
    if (canal !== "production") {
      return null;
    }
    const pointeur: PointeurProduction = {
      modelId,
      version,
      promuLe: new Date().toISOString(),
      origine: "promotion",
    };
    await this.ecrireAtomique(
      this.cheminPointeur(modelId),
      JSON.stringify(pointeur, null, 2),
    );
    return pointeur;
  }

  /**
   * ROLLBACK : re-pointe la production vers une version antérieure EXISTANTE
   * (aucune suppression, aucun changement de canal — l'historique reste
   * intact et latest(modelId, "production") suit immédiatement le pointeur).
   */
  async rollback(modelId: string, version: string): Promise<PointeurProduction> {
    const manifeste = await this.get(modelId, version);
    if (!manifeste) {
      throw new ErreurRegistre(
        `Version ${version} introuvable pour « ${modelId} » — rollback impossible (le registre ne pointe jamais vers une version absente).`,
        "INTROUVABLE",
      );
    }
    const pointeur: PointeurProduction = {
      modelId,
      version,
      promuLe: new Date().toISOString(),
      origine: "rollback",
    };
    await this.ecrireAtomique(
      this.cheminPointeur(modelId),
      JSON.stringify(pointeur, null, 2),
    );
    return pointeur;
  }

  /**
   * LIGNEAGE : remonte la chaîne des parentVersion depuis `depuis`
   * (défaut : version de production pointée, sinon la plus récente).
   * Retourne la chaîne du plus récent au plus ancien ; s'arrête proprement
   * sur une racine (parentVersion absente), un parent absent du registre
   * ou un cycle (garde par ensemble de versions visitées).
   */
  async lineage(modelId: string, depuis?: string): Promise<ManifestModele[]> {
    const chaine: ManifestModele[] = [];
    const visites = new Set<string>();

    let courant = depuis ?? (await this.pointeurProduction(modelId))?.version;
    if (!courant) {
      courant = (await this.list(modelId))[0]?.version;
    }

    while (courant && !visites.has(courant)) {
      visites.add(courant);
      const manifeste = await this.get(modelId, courant);
      if (!manifeste) break;
      chaine.push(manifeste);
      courant = manifeste.lineage?.parentVersion;
    }
    return chaine;
  }
}
