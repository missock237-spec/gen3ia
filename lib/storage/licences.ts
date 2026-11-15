/**
 * Licences d'espace de stockage — achats DIRECTS sur la boutique Chariow.
 *
 * Complément aux plans d'abonnement (lib/storage/plans.ts) : la boutique
 * publie deux produits « espace » achetés en un clic (widget tap Chariow,
 * paiement Mobile Money/carte) qui accordent un quota ADDITIONNEL PERMANENT
 * — pas d'abonnement, pas de renouvellement, aucune destruction de fichiers :
 *
 *   · « 100Go »  (prd_645l06yr) : +100 Go pour 3 000 FCFA
 *   · « 600Go »  (prd_vkequ0dn) : +600 Go pour 6 000 FCFA
 *
 * Quantités ALIGNÉES sur les produits réellement publiés (vérifiés vitrine
 * publique le 2026-10-25, devise boutique XAF) : le checkout facture le prix
 * du produit, l'affichage doit matcher. Les identifiants restent
 * surchargeables par env (même convention que lib/billing/plans.ts) :
 * CHARIOW_ESPACE_100_PRODUCT_ID / CHARIOW_ESPACE_600_PRODUCT_ID.
 *
 * Un achat direct par le widget n'emporte AUCUNE métadonnée plateforme : la
 * vente est reconnue au webhook Pulse par son identifiant produit
 * (lib/billing/chariow-delivery.ts) puis rapprochée du compte Gen3ia par
 * l'E-MAIL du client Chariow (même mécanique que la recharge wallet). Le
 * crédit de quota est IDEMPOTENT par vente : l'identifiant du document de
 * licence est dérivé du saleId (`chariow_${saleId}`) — une re-délivrance ou
 * une course entre deux workers ne peut jamais accorder deux fois l'espace.
 */

import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";

/** Unités SI : 1 Go = 1024³ octets (aligné sur FREE_QUOTA_BYTES de plans.ts). */
const GO = 1024 ** 3;

export type StorageLicenceId = "espace-100" | "espace-600";

export interface StorageLicenceDefinition {
  id: StorageLicenceId;
  /** Libellé affiché (carte boutique + profil de stockage). */
  label: string;
  /** Quota additionnel permanent accordé par la licence (octets). */
  extraBytes: number;
  /** Prix affiché — aligné sur le prix facturé par le produit Chariow. */
  priceLabel: string;
  /** Variable d'environnement du produit Chariow correspondant. */
  productIdEnv: string;
  /** Produit publié dans la boutique (repli de configuration). */
  defaultProductId: string;
}

const ESPACE_100_PRODUCT_ID = "prd_645l06yr";
const ESPACE_600_PRODUCT_ID = "prd_vkequ0dn";

/** Catalogue des licences d'espace — source unique de vérité (webhook + UI). */
export const STORAGE_LICENCES: readonly StorageLicenceDefinition[] = [
  {
    id: "espace-100",
    label: "Espace 100 Go",
    extraBytes: 100 * GO,
    priceLabel: "3 000 FCFA",
    productIdEnv: "CHARIOW_ESPACE_100_PRODUCT_ID",
    defaultProductId: ESPACE_100_PRODUCT_ID,
  },
  {
    id: "espace-600",
    label: "Espace 600 Go",
    extraBytes: 600 * GO,
    priceLabel: "6 000 FCFA",
    productIdEnv: "CHARIOW_ESPACE_600_PRODUCT_ID",
    defaultProductId: ESPACE_600_PRODUCT_ID,
  },
] as const;

/** Résout l'identifiant produit Chariow d'une licence (env → défaut boutique). */
export function resolveStorageLicenceProductId(licence: StorageLicenceDefinition): string {
  return process.env[licence.productIdEnv]?.trim() || licence.defaultProductId;
}

/**
 * Reconnaissance d'une vente de licence d'espace par identifiant produit.
 * null pour tout produit qui n'est pas une licence d'espace (le webhook
 * poursuit alors ses autres branchements : plans, recharge wallet…).
 */
export function resolveStorageLicenceForProduct(productId: unknown): StorageLicenceDefinition | null {
  const clean = String(productId ?? "").trim();
  if (!clean) return null;
  return STORAGE_LICENCES.find((licence) => resolveStorageLicenceProductId(licence) === clean) ?? null;
}

const LICENCES_COLLECTION = "storageLicences";

/** Résultat de l'attribution d'une licence d'espace. */
export interface StorageLicenceGrant {
  licenceId: StorageLicenceId;
  label: string;
  extraBytes: number;
  /** false si la vente avait DÉJÀ accordé sa licence (idempotence par saleId). */
  granted: boolean;
}

/**
 * Accorde la licence d'espace d'une vente à un utilisateur. IDEMPOTENT par
 * vente : le document porte l'identifiant `chariow_${saleId}` et `create()`
 * échoue s'il existe déjà (ALREADY_EXISTS) — la barrière est atomique, même
 * en course entre deux workers traitant deux livraisons d'une même vente.
 */
export async function grantStorageLicence(params: {
  userId: string;
  licence: StorageLicenceDefinition;
  saleId: string;
  productId: string;
}): Promise<StorageLicenceGrant> {
  if (!params.userId?.trim()) throw new Error("Storage licence requires a userId.");
  if (!params.saleId?.trim()) throw new Error("Storage licence requires a sale reference.");

  const grant: StorageLicenceGrant = {
    licenceId: params.licence.id,
    label: params.licence.label,
    extraBytes: params.licence.extraBytes,
    granted: true,
  };

  try {
    await adminDb.collection(LICENCES_COLLECTION).doc(`chariow_${params.saleId}`).create({
      userId: params.userId,
      licenceId: params.licence.id,
      label: params.licence.label,
      extraBytes: params.licence.extraBytes,
      productId: params.productId,
      saleId: params.saleId,
      source: "chariow_storefront",
      createdAt: FieldValue.serverTimestamp(),
    });
    return grant;
  } catch {
    // ALREADY_EXISTS : la vente a déjà été créditée (re-délivrance, course
    // entre workers ou reprise admin) — aucun double quota, résultat honnête.
    return { ...grant, granted: false };
  }
}

/** Vue stable d'une licence accordée (profil de stockage / UI). */
export interface StorageLicenceView {
  licenceId: string;
  label: string;
  extraBytes: number;
  /** Date d'attribution (ms epoch) — 0 si illisible. */
  grantedAt: number;
}

function toMillis(value: unknown): number {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

/**
 * Licences d'espace d'un utilisateur (détail affiché sur /storage). Borne de
 * lecture 200 documents : au-delà, l'agrégat resterait sous-estimé —
 * opérationnellement impossible (6 000 FCFA × 200), la borne protège surtout
 * le coût de lecture Firestore.
 */
export async function listStorageLicences(userId: string, limit = 200): Promise<StorageLicenceView[]> {
  if (!userId?.trim()) return [];
  const snapshot = await adminDb
    .collection(LICENCES_COLLECTION)
    .where("userId", "==", userId)
    .limit(Math.min(Math.max(limit, 1), 500))
    .get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data() as Partial<{ licenceId: unknown; label: unknown; extraBytes: unknown; createdAt: unknown }> | undefined;
      const extraBytes = Number(data?.extraBytes);
      return {
        licenceId: String(data?.licenceId ?? ""),
        label: String(data?.label ?? ""),
        extraBytes: Number.isFinite(extraBytes) && extraBytes > 0 ? extraBytes : 0,
        grantedAt: toMillis(data?.createdAt),
      };
    })
    .filter((licence) => licence.extraBytes > 0);
}

/** Somme du quota additionnel permanent accordé par les licences d'un utilisateur. */
export async function sumStorageLicenceExtraBytes(userId: string): Promise<number> {
  const licences = await listStorageLicences(userId);
  return licences.reduce((total, licence) => total + licence.extraBytes, 0);
}
