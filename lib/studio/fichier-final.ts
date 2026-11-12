import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { putObject } from "@/lib/storage/r2";
import { urlDurableRelative } from "@/lib/media/url-durable";

import type { RapportEvaluation } from "./evaluation";
import type { UniteConnaissance } from "./extraction-corpus";

/**
 * FICHIER FINAL DE L'IA ENTRAÎNÉE — STUDIO D'ENTRAÎNEMENT (demande
 * propriétaire : « livrer le FICHIER FINAL de l'IA entraînée »).
 *
 * `gen3iac-entrainement-<projet>.json` contient l'identité du projet, le
 * domaine, le compte du corpus ingéré, les métriques AVANT/APRÈS mesurées,
 * l'empreinte SHA-256 du pack ingéré, la date et la version.
 *
 * PERSISTANCE : le fichier vit dans l'ESPACE PERMANENT de l'utilisateur
 * (`users/{uid}/permanent/studio/…`) — le lien durable canonique
 * `/api/media/durable?path=…` (lib/media/url-durable.ts) résout ces clés en
 * URL signée FRAÎCHE à chaque clic : le lien du rapport reste jouable pour
 * toujours (même mécanique que la livraison média, jamais de lien expiré).
 *
 * HONNÊTETÉ : l'empreinte SHA-256 couvre le PACK ingéré (unités sérialisées
 * canoniquement) — vérifiable par quiconque re-sérialise le pack ; elle ne
 * prétend PAS hasher des poids neuronaux (aucun poids n'est produit ici,
 * cf. limites documentées dans le rapport final du Studio).
 */

/** Version du format du fichier final. */
export const VERSION_FICHIER_FINAL = 1;

// ─── EMPREINTE DU PACK ───────────────────────────────────────────────────────

/** Sérialisation canonique du pack (tri récursif des clés — même algorithme
 * que user-data-store) : la même unité donne toujours la même chaîne. */
function serialiserCanonique(valeur: unknown): string {
  const trier = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(trier);
    if (v !== null && typeof v === "object") {
      const entrees = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return Object.fromEntries(entrees.map(([cle, v2]) => [cle, trier(v2)]));
    }
    return v;
  };
  return JSON.stringify(trier(valeur));
}

/** Empreinte SHA-256 du pack ingéré (unités sérialisées canoniquement). */
export function empreintePackSha256(unites: readonly UniteConnaissance[]): string {
  return createHash("sha256").update(serialiserCanonique(unites), "utf8").digest("hex");
}

// ─── CONTENU DU FICHIER ──────────────────────────────────────────────────────

/** Contenu du fichier final (forme exacte documentée, versionnée). */
export interface ContenuFichierFinal {
  readonly format: "gen3iac-entrainement";
  readonly version: number;
  readonly genereeLe: string;
  readonly projet: { readonly id: string; readonly nom: string };
  readonly domaine: string;
  readonly corpus: {
    readonly ressources: number;
    readonly unites: number;
    readonly parType: Record<string, number>;
    readonly octets: number;
    readonly empreintePackSha256: string;
  };
  readonly evaluation: RapportEvaluation;
  readonly memoire: {
    readonly cleStockage: string;
    readonly unitesPersistees: number;
  };
  /** Empreinte SHA-256 du pack ingéré (integrité vérifiable). */
  readonly packSha256: string;
  /** Récapitulatif honnête de ce qui a été entraîné (aucune prétention). */
  readonly note: string;
}

/** Construit le contenu du fichier final (pur — testable sans R2). */
export function construireFichierFinal(params: {
  projet: { id: string; nom: string };
  domaine: string;
  unites: readonly UniteConnaissance[];
  ressources: number;
  evaluation: RapportEvaluation;
  cleStockageMemoire: string;
  unitesPersistees: number;
  genereeLe?: string;
}): ContenuFichierFinal {
  const parType: Record<string, number> = { qa: 0, fait: 0, code: 0 };
  let octets = 0;
  for (const u of params.unites) {
    parType[u.type] = (parType[u.type] ?? 0) + 1;
    octets += u.octets;
  }
  const empreinte = empreintePackSha256(params.unites);
  return {
    format: "gen3iac-entrainement",
    version: VERSION_FICHIER_FINAL,
    genereeLe: params.genereeLe ?? new Date().toISOString(),
    projet: { id: params.projet.id, nom: params.projet.nom.slice(0, 120) },
    domaine: params.domaine.slice(0, 60),
    corpus: {
      ressources: params.ressources,
      unites: params.unites.length,
      parType,
      octets,
      empreintePackSha256: empreinte,
    },
    evaluation: params.evaluation,
    memoire: {
      cleStockage: params.cleStockageMemoire,
      unitesPersistees: params.unitesPersistees,
    },
    packSha256: empreinte,
    note:
      "Mémoire de connaissance réelle ingérée depuis les ressources du propriétaire et " +
      "consultée par le cerveau Gen3 à la réponse (étage memoire_utilisateur) — " +
      "aucun poids neuronal n'est entraîné (cf. limites honnêtes du Studio).",
  };
}

// ─── PERSISTANCE PERMANENTE + LIEN DURABLE ───────────────────────────────────

/** Slug de nom de projet pour le nom de fichier (sûr, lisible). */
function slugNomProjet(nom: string): string {
  const slug = nom
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "projet";
}

/** Nom canonique du fichier final : gen3iac-entrainement-<projet>.json
 * (suffixe ULID pour ne jamais écraser une livraison précédente). */
export function nomFichierFinal(nomProjet: string, suffixe = randomUUID()): string {
  return `gen3iac-entrainement-${slugNomProjet(nomProjet)}-${suffixe}.json`;
}

/** Écrit le fichier final dans l'ESPACE PERMANENT de l'utilisateur et
 * retourne la clé de stockage + taille réelle. */
export async function persisterFichierFinal(
  uid: string,
  contenu: ContenuFichierFinal,
  nomFichier: string,
): Promise<{ cle: string; taille: number }> {
  const corps = Buffer.from(JSON.stringify(contenu, null, 2), "utf8");
  const cle = `users/${uid}/permanent/studio/${nomFichier}`;
  await putObject({
    key: cle,
    body: corps,
    contentType: "application/json",
    contentLength: corps.byteLength,
  });
  return { cle, taille: corps.byteLength };
}

/** Lien durable du fichier final (route canonique /api/media/durable —
 * résolue en URL signée fraîche à chaque résolution, jamais expirée). */
export function lienDurableFichierFinal(cle: string): string | null {
  return urlDurableRelative(cle);
}

/** Vérifie qu'un contenu de fichier final est cohérent (SHA-256 du pack
 * recalculé = SHA-256 annoncé) — contrôle d'intégrité du livrable. */
export function verifierEmpreinteFichierFinal(
  contenu: ContenuFichierFinal,
  unites: readonly UniteConnaissance[],
): boolean {
  return contenu.packSha256 === empreintePackSha256(unites);
}
