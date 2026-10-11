import { EXTENSION_CATEGORIES } from "@/lib/extensions/manifest";
import packageJson from "../../package.json";

/**
 * MARKETPLACE — MATRICE DE COMPATIBILITÉ DES EXTENSIONS (Task 132).
 *
 * Répond à la question « cette extension peut-elle fonctionner sur la
 * plateforme actuelle ? » de façon DÉTERMINISTE et SANS dépendance :
 *  - version minimale de plateforme (comparaison semver MANUELLE : parse
 *    « MAJEUR.MINEUR.CORRECTIF » en nombres, comparaison dans cet ordre) ;
 *  - capacités plateforme exigées : la BASELINE de la catégorie de
 *    l'extension (REQUIRED_CAPABILITIES / COMPATIBILITY_MATRIX) UNION les
 *    capacités propres déclarées par l'extension, chacune devant exister au
 *    catalogue PLATFORM_CAPABILITIES (et y être disponible à la version
 *    courante via son champ `since`).
 *
 * Source de vérité des catégories : EXTENSION_CATEGORIES de
 * lib/extensions/manifest (le manifest est LE schéma des extensions).
 *
 * PLATFORM_VERSION est lue À L'EXÉCUTION depuis package.json
 * (resolveJsonModule est actif dans la config TS du projet) ; si la version
 * lue n'était pas un semver valide, repli documenté sur la constante
 * synchronisée FALLBACK_PLATFORM_VERSION.
 *
 * Module de données + logique pure : consommable côté serveur, par les
 * routes d'installation/essai et par les tests (aucune E/S).
 */

/* ------------------------------------------------------------------ */
/* Version de la plateforme                                            */
/* ------------------------------------------------------------------ */

/** Repli documenté — synchronisé avec la version de package.json. */
const FALLBACK_PLATFORM_VERSION = "1.0.0";

const PACKAGE_VERSION =
  typeof packageJson?.version === "string" && packageJson.version.trim() ? packageJson.version.trim() : "";

/**
 * Version sémantique courante de la plateforme Gen3ia (package.json,
 * lue à l'exécution ; repli documenté si illisible).
 */
export const PLATFORM_VERSION: string = parseSemver(PACKAGE_VERSION) ? PACKAGE_VERSION : FALLBACK_PLATFORM_VERSION;

/* ------------------------------------------------------------------ */
/* Semver manuel (zéro dépendance)                                     */
/* ------------------------------------------------------------------ */

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse « x.y.z » en nombres (majeur/mineur/correctif). Null si le format
 * n'est pas un semver strict — AUCUNE tolérance (préfixe « v », suffixes
 * pré-release ou méta sont refusés : le manifest des extensions impose
 * déjà SEMVER_REGEX strict).
 */
export function parseSemver(version: string): SemverParts | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

/**
 * Comparaison semver MANUELLE : -1 si a < b, 0 si a === b, 1 si a > b
 * (majeur, puis mineur, puis correctif). Lève sur version invalide — les
 * appelants valident d'abord via parseSemver quand l'entrée est incertaine.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    throw new Error(
      `Version sémantique invalide : « ${!left ? a : b} » (format attendu : MAJEUR.MINEUR.CORRECTIF, par ex. 1.2.0).`,
    );
  }
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/* ------------------------------------------------------------------ */
/* Capacités de la plateforme                                          */
/* ------------------------------------------------------------------ */

/**
 * Cataloge des capacités plateforme — chaque entrée correspond à une
 * capacité RÉELLE du projet : `label` lisible pour l'UI, `since` = première
 * version de la plateforme offrant la capacité.
 */
export const PLATFORM_CAPABILITIES = {
  /** SDK public @gen3ia/sdk + API des extensions. */
  "api.v1": { label: "API publique v1", since: "1.0.0" },
  /** Terminal intégré des agents (lib/tools/terminal — exécution réelle). */
  "terminal": { label: "Exécution terminal isolée", since: "1.0.0" },
  /** Production vidéo autonome (lib/video + file de rendu). */
  "media.video": { label: "Production vidéo", since: "1.0.0" },
  /** Voix : synthèse vocale et appels téléphoniques IA (lib/voice). */
  "voice": { label: "Voix et appels IA", since: "1.0.0" },
  /** Analyse de médias (lib/tools/media/analyze-media — vision). */
  "browser.vision": { label: "Analyse visuelle des médias", since: "1.0.0" },
  /** Stockage permanent utilisateur (lib/r2fs — R2 S3 compatible). */
  "storage.r2": { label: "Stockage permanent R2", since: "1.0.0" },
  /** Mémoire vectorielle sémantique (lib/memory — embeddings). */
  "memory.vector": { label: "Mémoire vectorielle", since: "1.0.0" },
  /** Connecteurs HTTP externes (permissions http.fetch:<domaine>). */
  "http.fetch": { label: "Connecteurs HTTP externes", since: "1.0.0" },
} as const satisfies Record<string, { label: string; since: string }>;

export type PlatformCapability = keyof typeof PLATFORM_CAPABILITIES;

/* ------------------------------------------------------------------ */
/* Matrice catégorie → capacités                                       */
/* ------------------------------------------------------------------ */

/** Catégorie d'extension réelle du projet (source : lib/extensions/manifest). */
export type MarketplaceCategory = (typeof EXTENSION_CATEGORIES)[number];

/**
 * Capacités plateforme EXIGÉES par catégorie d'extension (baseline) :
 * une extension de la catégorie doit pouvoir s'appuyer sur ces capacités
 * pour délivrer sa promesse. Les exigences PROPRES de l'extension
 * (`requiredCapabilities`) s'y AJOUTENT (union).
 */
export const REQUIRED_CAPABILITIES: Readonly<Record<MarketplaceCategory, readonly PlatformCapability[]>> = {
  productivity: ["api.v1", "storage.r2"],
  marketing: ["api.v1", "media.video", "browser.vision"],
  data: ["api.v1", "terminal", "storage.r2"],
  ai: ["api.v1", "memory.vector"],
  devtools: ["api.v1", "terminal", "http.fetch"],
  finance: ["api.v1", "terminal"],
  communication: ["api.v1", "voice", "http.fetch"],
  other: ["api.v1"],
};

/**
 * MATRICE DE COMPATIBILITÉ (nom consommable par l'UI et les tests) :
 * même objet que REQUIRED_CAPABILITIES, exposé sous le nom du contrat
 * Task 132 — catégorie → capacités plateforme exigées.
 */
export const COMPATIBILITY_MATRIX = REQUIRED_CAPABILITIES;

/* ------------------------------------------------------------------ */
/* Contrôle de compatibilité                                           */
/* ------------------------------------------------------------------ */

/** Entrée du contrôle : champs de l'extension utiles à la compatibilité. */
export interface CompatibilityInput {
  /** Catégorie du manifest (EXTENSION_CATEGORIES). */
  category: string;
  /** Version minimale de plateforme exigée (semver strict). */
  minPlatformVersion?: string;
  /** Capacités plateforme supplémentaires exigées par l'extension. */
  requiredCapabilities?: string[];
}

export interface CompatibilityResult {
  ok: boolean;
  /** Raisons en français, une par blocage (vide si ok). */
  reasons: string[];
}

/**
 * Contrôle de compatibilité (PUR) : renvoie { ok, reasons } — jamais
 * d'exception, chaque blocage produit UNE raison en français.
 *  1. catégorie inconnue (hors EXTENSION_CATEGORIES) ;
 *  2. minPlatformVersion invalide ou supérieure à la plateforme courante ;
 *  3. capacité exigée (baseline ∪ propres) absente du catalogue, ou
 *     disponible seulement à partir d'une version postérieure.
 */
export function checkCompatibility(extension: CompatibilityInput): CompatibilityResult {
  const reasons: string[] = [];

  // 1) Catégorie réelle du projet.
  const category = typeof extension.category === "string" ? extension.category.trim() : "";
  const baseline = (REQUIRED_CAPABILITIES as Record<string, readonly PlatformCapability[]>)[category];
  if (!baseline) {
    reasons.push(
      `Catégorie d'extension inconnue : « ${category || "(vide)"} ». Catégories reconnues : ${EXTENSION_CATEGORIES.join(", ")}.`,
    );
  }

  // 2) Version minimale de plateforme (semver manuel).
  const minRaw = typeof extension.minPlatformVersion === "string" ? extension.minPlatformVersion.trim() : "";
  if (minRaw) {
    const min = parseSemver(minRaw);
    if (!min) {
      reasons.push(
        `Version minimale de plateforme invalide : « ${minRaw} » (format attendu : MAJEUR.MINEUR.CORRECTIF, par ex. 1.2.0).`,
      );
    } else if (compareVersions(PLATFORM_VERSION, minRaw) < 0) {
      reasons.push(
        `Cette extension nécessite la plateforme ≥ ${minRaw} ; la version actuelle est ${PLATFORM_VERSION}.`,
      );
    }
  }

  // 3) Capacités exigées : baseline de la catégorie ∪ exigences propres.
  const required = new Set<PlatformCapability>([
    ...(baseline ?? []),
    ...(Array.isArray(extension.requiredCapabilities) ? (extension.requiredCapabilities as PlatformCapability[]) : []),
  ]);
  for (const capability of required) {
    const known = PLATFORM_CAPABILITIES[capability];
    if (!known) {
      reasons.push(
        `La plateforme Gen3ia ne prend pas en charge la capacité « ${capability} » requise par cette extension.`,
      );
      continue;
    }
    if (compareVersions(known.since, PLATFORM_VERSION) > 0) {
      reasons.push(
        `La capacité « ${known.label} » nécessite la plateforme ≥ ${known.since} ; la version actuelle est ${PLATFORM_VERSION}.`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}
