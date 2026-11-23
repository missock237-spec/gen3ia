import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPlanState } from "@/lib/billing/abonnements";
import type { PlanId } from "@/lib/billing/plans";

/**
 * CLÉS DE NIVEAU UNIQUE D'ENTRAÎNEMENT (facturation).
 *
 * Exigence produit : AVANT d'entraîner un modèle, gen3 VÉRIFIE que
 * l'utilisateur possède une clé de niveau unique d'entraînement, obtenue
 * depuis la facturation. La clé est délivrée SEULEMENT si l'abonnement
 * courant couvre le niveau demandé (grille commerciale plans.ts) :
 *
 *   standard (1)  → plan Pro            (datasets_api)
 *   avance   (2)  → plan Entreprise     (private_mesh)
 *   integral (3)  → plan Sur-mesure     (arene_ondes)
 *
 * La clé est matérialisée au format `g3t_<niveau>_<64 hex>`, stockée PAR
 * SON SHA-256 uniquement (jamais en clair — même discipline que `g3a_`),
 * avec son propriétaire, son niveau et sa traçabilité facturation. Toute
 * fonction d'entraînement du studio passe par `exigerCleEntrainement` :
 * sans clé valable au niveau requis, l'entraînement REFUSE (honnêteté :
 * on explique comment l'obtenir, on ne simule jamais une dérogation).
 */

export const PREFIXE_CLE_ENTRAINEMENT = "g3t_";

export const NIVEAUX_ENTRAINEMENT = ["standard", "avance", "integral"] as const;
export type NiveauEntrainement = (typeof NIVEAUX_ENTRAINEMENT)[number];

export const RANG_NIVEAU: Record<NiveauEntrainement, number> = {
  standard: 1,
  avance: 2,
  integral: 3,
};

/** Entitlement de facturation qui couvre chaque niveau (plans.ts). */
export const ENTITLEMENT_PAR_NIVEAU: Record<NiveauEntrainement, string> = {
  standard: "datasets_api",
  avance: "private_mesh",
  integral: "arene_ondes",
};

/** Capacités matérielles couvertes par niveau (entraînement + monde virtuel). */
export const CAPACITES_PAR_NIVEAU: Record<
  NiveauEntrainement,
  { parametresMax: number; epoquesMax: number; episodesMondeMax: number; memoireMoMax: number }
> = {
  standard: { parametresMax: 50_000, epoquesMax: 60, episodesMondeMax: 60, memoireMoMax: 512 },
  avance: { parametresMax: 500_000, epoquesMax: 200, episodesMondeMax: 200, memoireMoMax: 2048 },
  integral: { parametresMax: 5_000_000, epoquesMax: 600, episodesMondeMax: 600, memoireMoMax: 8192 },
};

/** Niveau maximal délivrable selon le plan de facturation (null = aucun). */
export function niveauAutorisePourPlan(planId: PlanId): NiveauEntrainement | null {
  switch (planId) {
    case "modele-sur-mesure":
      return "integral";
    case "entreprise":
      return "avance";
    case "pro":
      return "standard";
    default:
      return null;
  }
}

export interface CleEntrainementStockee {
  /** SHA-256 hex de la clé en clair — identifiant de stockage. */
  keyId: string;
  /** Premier segment de la clé en clair (affichage, sans secret). */
  apercu: string;
  userId: string;
  niveau: NiveauEntrainement;
  delivreeLe: string;
  /** Source de délivrance — toujours la facturation (exigence produit). */
  source: "facturation";
  planId: PlanId;
  revoquee: boolean;
}

export interface EntrepotCles {
  lire(keyId: string): Promise<CleEntrainementStockee | null>;
  ecrire(doc: CleEntrainementStockee): Promise<void>;
  lister(userId: string): Promise<CleEntrainementStockee[]>;
}

/** Entrepôt FICHIERS réel (var/training/cles/<keyId>.json, écriture atomique). */
export function creerEntrepotClesFichiers(racine: string): EntrepotCles {
  const fichier = (keyId: string) => join(racine, `${keyId}.json`);
  return {
    async lire(keyId) {
      try {
        return JSON.parse(readFileSync(fichier(keyId), "utf-8")) as CleEntrainementStockee;
      } catch {
        return null;
      }
    },
    async ecrire(doc) {
      mkdirSync(racine, { recursive: true });
      const tmp = `${fichier(doc.keyId)}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf-8");
      renameSync(tmp, fichier(doc.keyId));
    },
    async lister(userId) {
      let noms: string[] = [];
      try {
        noms = readdirSync(racine);
      } catch {
        return [];
      }
      const docs: CleEntrainementStockee[] = [];
      for (const nom of noms.filter((n) => n.endsWith(".json"))) {
        try {
          const doc = JSON.parse(readFileSync(join(racine, nom), "utf-8")) as CleEntrainementStockee;
          if (doc.userId === userId) docs.push(doc);
        } catch {
          /* fichier corrompu : ignoré honnêtement */
        }
      }
      return docs.sort((a, b) => a.delivreeLe.localeCompare(b.delivreeLe));
    },
  };
}

const RACINE_DEFAUT = join(process.cwd(), "var", "training", "cles");
let entrepotActif: EntrepotCles = creerEntrepotClesFichiers(RACINE_DEFAUT);

/** Point d'injection (tests, déploiements alternatifs) — le défaut reste fichiers. */
export function definirEntrepotCles(entrepot: EntrepotCles): void {
  entrepotActif = entrepot;
}

export function hacherCleEntrainement(cle: string): string {
  return createHash("sha256").update(cle.trim()).digest("hex");
}

export interface ResultatDelivrance {
  /** Clé en clair — affichée UNE SEULE fois à la délivrance. */
  cle: string;
  keyId: string;
  apercu: string;
  niveau: NiveauEntrainement;
  planId: PlanId;
}

/** Délivre une clé SI le plan de facturation couvre le niveau (sinon refuse). */
export async function delivrerCleEntrainement(params: {
  userId: string;
  niveau: NiveauEntrainement;
  planId: PlanId;
  planActif: boolean;
}): Promise<ResultatDelivrance> {
  if (!params.userId?.trim()) throw new Error("Délivrance : userId requis.");
  if (!params.planActif) {
    throw new Error("Aucun abonnement actif : la clé d'entraînement s'obtient depuis la facturation.");
  }
  const niveauPlan = niveauAutorisePourPlan(params.planId);
  if (!niveauPlan || RANG_NIVEAU[niveauPlan] < RANG_NIVEAU[params.niveau]) {
    throw new Error(
      `Le plan « ${params.planId} » ne couvre pas le niveau « ${params.niveau} » — niveau maximal délivrable : ${niveauPlan ?? "aucun"}.`,
    );
  }
  const cle = `${PREFIXE_CLE_ENTRAINEMENT}${params.niveau}_${randomBytes(32).toString("hex")}`;
  const keyId = hacherCleEntrainement(cle);
  const doc: CleEntrainementStockee = {
    keyId,
    apercu: cle.slice(0, PREFIXE_CLE_ENTRAINEMENT.length + params.niveau.length + 1 + 8),
    userId: params.userId,
    niveau: params.niveau,
    delivreeLe: new Date().toISOString(),
    source: "facturation",
    planId: params.planId,
    revoquee: false,
  };
  await entrepotActif.ecrire(doc);
  return { cle, keyId, apercu: doc.apercu, niveau: params.niveau, planId: params.planId };
}

/** Chemin d'obtention OFFICIEL : l'état d'abonnement (facturation) décide. */
export async function delivrerDepuisFacturation(params: {
  userId: string;
  niveau: NiveauEntrainement;
}): Promise<ResultatDelivrance> {
  const etat = await getPlanState(params.userId);
  return delivrerCleEntrainement({
    userId: params.userId,
    niveau: params.niveau,
    planId: etat.planId,
    planActif: etat.active,
  });
}

export type VerdictCle =
  | { autorise: true; keyId: string; niveau: NiveauEntrainement }
  | { autorise: false; raison: string; remediation: string };

/** VÉRIFICATION PRÉALABLE À TOUT ENTRAÎNEMENT (exigence produit, non négociable). */
export async function verifierCleEntrainement(params: {
  userId: string;
  cle: string;
  niveauRequis: NiveauEntrainement;
}): Promise<VerdictCle> {
  const raisonBase = {
    remediation: `Obtenir une clé de niveau « ${params.niveauRequis} » depuis la facturation (POST /api/training/keys), puis relancer.`,
  };
  if (!params.cle?.startsWith(PREFIXE_CLE_ENTRAINEMENT)) {
    return { autorise: false, raison: "Clé absente ou format invalide (attendu g3t_…).", ...raisonBase };
  }
  const doc = await entrepotActif.lire(hacherCleEntrainement(params.cle));
  if (!doc || doc.userId !== params.userId) {
    return { autorise: false, raison: "Clé inconnue pour ce compte.", ...raisonBase };
  }
  if (doc.revoquee) {
    return { autorise: false, raison: "Clé révoquée (facturation).", ...raisonBase };
  }
  if (RANG_NIVEAU[doc.niveau] < RANG_NIVEAU[params.niveauRequis]) {
    return {
      autorise: false,
      raison: `Clé de niveau « ${doc.niveau} » insuffisante pour « ${params.niveauRequis} » (capacités : ${JSON.stringify(CAPACITES_PAR_NIVEAU[doc.niveau])}).`,
      ...raisonBase,
    };
  }
  return { autorise: true, keyId: doc.keyId, niveau: doc.niveau };
}

/** Variante impérative pour les outils gen3 — refuse avec un message actionnable. */
export async function exigerCleEntrainement(params: {
  userId: string;
  cle: string;
  niveauRequis: NiveauEntrainement;
}): Promise<{ keyId: string; niveau: NiveauEntrainement }> {
  const verdict = await verifierCleEntrainement(params);
  if (!verdict.autorise) throw new Error(`Entraînement refusé : ${verdict.raison} ${verdict.remediation}`);
  return { keyId: verdict.keyId, niveau: verdict.niveau };
}

export async function revoquerCleEntrainement(params: { userId: string; cle: string }): Promise<boolean> {
  const keyId = hacherCleEntrainement(params.cle);
  const doc = await entrepotActif.lire(keyId);
  if (!doc || doc.userId !== params.userId) return false;
  await entrepotActif.ecrire({ ...doc, revoquee: true });
  return true;
}

export async function listerClesEntrainement(userId: string): Promise<CleEntrainementStockee[]> {
  return entrepotActif.lister(userId);
}
