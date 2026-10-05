import { AggregateField, FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { encryptSecret, decryptSecret } from "@/lib/security/secret-envelope";
import { compareSemver, type ExtensionManifest } from "./manifest";
import { computeRevenueSplit } from "./pricing";

/**
 * Firestore repository for the Gen3ia Extension Platform.
 */

export const EXTENSION_STATUS = ["draft", "pending", "approved", "rejected", "suspended"] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUS)[number];
export const VERSION_STATUS = ["draft", "pending", "approved", "rejected"] as const;
export type VersionStatus = (typeof VERSION_STATUS)[number];

export interface ExtensionDoc {
  id: string; name: string; description: string; category: string; tags: string[];
  developerId: string; developerName: string; projectId: string; status: ExtensionStatus; permissions: string[];
  pricing: ExtensionManifest["pricing"]; latestVersion: string | null; approvedVersion: string | null;
  stats: { installs: number; ratingSum: number; ratingCount: number; executions: number };
  createdAt: number; updatedAt: number; deletedAt?: number | null;
}
export interface ExtensionVersionDoc {
  id: string; extensionId: string; version: string; changelog: string; status: VersionStatus;
  manifest: ExtensionManifest; submittedAt?: number | null; reviewedAt?: number | null;
  reviewNote?: string | null; createdAt: number;
}
export interface InstallationDoc {
  id: string; extensionId: string; userId: string; version: string;
  status: "active" | "disabled" | "uninstalled"; permissionsGranted: string[];
  settings: Record<string, string | number | boolean>; installedAt: number; updatedAt: number; deletedAt?: number | null;
}
const COL = { developers:"developers", apiKeys:"developerApiKeys", extensions:"extensions", versions:"extensionVersions", installations:"extensionInstallations", entitlements:"extensionEntitlements", purchases:"extensionPurchases", licenses:"extensionLicenses", reviews:"extensionReviews", reports:"extensionReports", executions:"extensionExecutions", usage:"extensionUsageCounters", secrets:"extensionSecrets", revenue:"developerRevenue", payouts:"developerPayouts", payoutStats:"developerPayoutStats" } as const;
function now(){return Date.now();}
function extensionRef(id:string){return adminDb.collection(COL.extensions).doc(id);}
function versionRef(extensionId:string,version:string){return adminDb.collection(COL.versions).doc(`${extensionId}@${version}`);}
function installationRef(extensionId:string,userId:string){return adminDb.collection(COL.installations).doc(`${extensionId}__${userId}`);}
function entitlementRef(extensionId:string,userId:string){return adminDb.collection(COL.entitlements).doc(`${extensionId}__${userId}`);}

export async function ensureDeveloperProfile(userId:string,displayName:string){const ref=adminDb.collection(COL.developers).doc(userId);await ref.set({userId,displayName:displayName.slice(0,120),createdAt:now(),updatedAt:now(),deletedAt:null},{merge:true});const snap=await ref.get();return snap.data() as {userId:string;displayName:string;createdAt:number};}
export async function createExtension(developer:{userId:string;displayName:string;projectId:string},manifest:ExtensionManifest):Promise<ExtensionDoc>{const ref=extensionRef(manifest.id);const batch=adminDb.batch();const timestamp=now();batch.create(ref,{id:manifest.id,name:manifest.name,description:manifest.description,category:manifest.category,tags:manifest.tags??[],developerId:developer.userId,developerName:developer.displayName.slice(0,120),projectId:developer.projectId,status:"draft",permissions:manifest.permissions,pricing:manifest.pricing,latestVersion:manifest.version,approvedVersion:null,stats:{installs:0,ratingSum:0,ratingCount:0,executions:0},createdAt:timestamp,updatedAt:timestamp,deletedAt:null});batch.create(versionRef(manifest.id,manifest.version),{id:`${manifest.id}@${manifest.version}`,extensionId:manifest.id,version:manifest.version,changelog:"Initial version.",status:"draft",manifest,submittedAt:null,reviewedAt:null,reviewNote:null,createdAt:timestamp});await batch.commit();const snap=await ref.get();return snap.data() as ExtensionDoc;}
export async function getExtension(id:string){const snap=await extensionRef(id).get();return (snap.data() as ExtensionDoc|undefined)??null;}
export async function listApprovedExtensions(options:{q?:string;category?:string;limit?:number}):Promise<ExtensionDoc[]>{let query:FirebaseFirestore.Query=adminDb.collection(COL.extensions).where("status","==","approved").where("deletedAt","==",null).orderBy("stats.installs","desc").limit(Math.min(options.limit??48,100));if(options.category)query=query.where("category","==",options.category);const snap=await query.get();const docs=snap.docs.map(d=>d.data() as ExtensionDoc);const needle=options.q?.trim().toLowerCase();if(!needle)return docs;return docs.filter(d=>d.name.toLowerCase().includes(needle)||d.description.toLowerCase().includes(needle)||d.tags.some(t=>t.toLowerCase().includes(needle)));}
export async function listExtensionsByDeveloper(developerId:string,projectId?:string){let query:FirebaseFirestore.Query=adminDb.collection(COL.extensions).where("developerId","==",developerId);if(projectId)query=query.where("projectId","==",projectId);query=query.where("deletedAt","==",null).orderBy("createdAt","desc").limit(100);const snap=await query.get();return snap.docs.map(d=>d.data() as ExtensionDoc);}
export async function softDeleteExtension(id:string,developerId:string,projectId?:string){const doc=await getExtension(id);if(!doc)throw new Error("Extension not found.");if(doc.developerId!==developerId)throw new Error("Only the developer may delete this extension.");if(projectId&&doc.projectId!==projectId)throw new Error("Extension is not linked to this Gen3ia project.");await extensionRef(id).update({deletedAt:now(),status:"suspended",updatedAt:now()});}
export async function createVersion(developerId:string,projectId:string,manifest:ExtensionManifest,changelog:string):Promise<ExtensionVersionDoc>{const extension=await getExtension(manifest.id);if(!extension)throw new Error("Extension not found.");if(extension.developerId!==developerId)throw new Error("Only the developer may add versions.");if(extension.projectId!==projectId)throw new Error("Extension is not linked to this Gen3ia project.");const ref=versionRef(manifest.id,manifest.version);await adminDb.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists)throw new Error(`Version ${manifest.version} already exists.`);const timestamp=now();tx.create(ref,{id:`${manifest.id}@${manifest.version}`,extensionId:manifest.id,version:manifest.version,changelog:changelog.slice(0,2000),status:"draft",manifest,submittedAt:null,reviewedAt:null,reviewNote:null,createdAt:timestamp});if(!extension.latestVersion||compareSemver(manifest.version,extension.latestVersion)>0)tx.update(extensionRef(manifest.id),{latestVersion:manifest.version,updatedAt:timestamp});});const snap=await ref.get();return snap.data() as ExtensionVersionDoc;}
export async function getVersion(extensionId:string,version:string){const snap=await versionRef(extensionId,version).get();return(snap.data() as ExtensionVersionDoc|undefined)??null;}
export async function listVersions(extensionId:string,developerId?:string,projectId?:string){if(developerId&&projectId)await assertExtensionProject(extensionId,developerId,projectId);const snap=await adminDb.collection(COL.versions).where("extensionId","==",extensionId).orderBy("createdAt","desc").limit(50).get();return snap.docs.map(d=>d.data() as ExtensionVersionDoc);}
export async function getLatestApprovedVersion(extensionId:string){const extension=await getExtension(extensionId);if(!extension?.approvedVersion)return null;return getVersion(extensionId,extension.approvedVersion);}
export async function submitVersion(developerId:string,extensionId:string,version:string,projectId?:string){const extension=await getExtension(extensionId);if(!extension)throw new Error("Extension not found.");if(extension.developerId!==developerId)throw new Error("Only the developer may submit this extension.");if(projectId&&extension.projectId!==projectId)throw new Error("Extension is not linked to this Gen3ia project.");const ref=versionRef(extensionId,version);await ref.update({status:"pending",submittedAt:now()});await extensionRef(extensionId).update({status:"pending",updatedAt:now()});const snap=await ref.get();return snap.data() as ExtensionVersionDoc;}
export async function reviewVersion(params:{extensionId:string;version:string;decision:"approved"|"rejected";note?:string}){const timestamp=now();await adminDb.runTransaction(async tx=>{const ref=versionRef(params.extensionId,params.version);const snap=await tx.get(ref);if(!snap.exists)throw new Error("Version not found.");tx.update(ref,{status:params.decision,reviewedAt:timestamp,reviewNote:params.note?.slice(0,1000)??null});if(params.decision==="approved")tx.update(extensionRef(params.extensionId),{status:"approved",approvedVersion:params.version,updatedAt:timestamp});else tx.update(extensionRef(params.extensionId),{status:"rejected",updatedAt:timestamp});});}
export async function suspendExtension(extensionId:string,note?:string){await extensionRef(extensionId).update({status:"suspended",updatedAt:now(),reviewNote:note??null});}
export async function listPendingVersions(limit=50){const snap=await adminDb.collection(COL.versions).where("status","==","pending").orderBy("submittedAt","asc").limit(limit).get();return snap.docs.map(d=>d.data() as ExtensionVersionDoc);}

export async function installExtension(params:{userId:string;extension:ExtensionDoc;version:string;permissionsGranted:string[];settings?:Record<string,string|number|boolean>}):Promise<InstallationDoc>{const timestamp=now();const ref=installationRef(params.extension.id,params.userId);await adminDb.runTransaction(async tx=>{const snap=await tx.get(ref);const wasActive=snap.exists&&snap.get("status")==="active";const data:InstallationDoc={id:`${params.extension.id}__${params.userId}`,extensionId:params.extension.id,userId:params.userId,version:params.version,status:"active",permissionsGranted:params.permissionsGranted,settings:params.settings??{},installedAt:snap.exists?Number(snap.get("installedAt")):timestamp,updatedAt:timestamp,deletedAt:null};tx.set(ref,data);if(!wasActive)tx.update(extensionRef(params.extension.id),{"stats.installs":FieldValue.increment(1),updatedAt:timestamp});});const snap=await ref.get();return snap.data() as InstallationDoc;}
export async function getInstallation(extensionId:string,userId:string){const snap=await installationRef(extensionId,userId).get();return(snap.data() as InstallationDoc|undefined)??null;}
export async function uninstallExtension(extensionId:string,userId:string){const timestamp=now();await adminDb.runTransaction(async tx=>{const ref=installationRef(extensionId,userId);const snap=await tx.get(ref);if(!snap.exists)throw new Error("This extension is not installed.");if(snap.get("status")==="uninstalled")return;tx.update(ref,{status:"uninstalled",deletedAt:timestamp,updatedAt:timestamp});tx.update(extensionRef(extensionId),{"stats.installs":FieldValue.increment(-1),updatedAt:timestamp});});}
export async function updateInstallationVersion(extensionId:string,userId:string,version:string):Promise<InstallationDoc>{const ref=installationRef(extensionId,userId);const snap=await ref.get();if(!snap.exists)throw new Error("This extension is not installed.");if(snap.get("status")!=="active")throw new Error("This extension installation is not active.");const current=snap.data() as InstallationDoc;const latest=await getLatestApprovedVersion(extensionId);if(!latest)throw new Error("No approved version available.");if(compareSemver(version,latest.version)>=0&&version!==latest.version)throw new Error("Requested version is not older than the latest approved version.");const previous=new Set(current.permissionsGranted??[]);const nextManifest=new Set(latest.manifest.permissions??[]);const preserved=[...previous].filter(p=>nextManifest.has(p));const newlyRequested=[...nextManifest].filter(p=>!previous.has(p));await ref.update({version:latest.version,permissionsGranted:preserved,permissionConsentRequired:newlyRequested.length>0,newlyRequestedPermissions:newlyRequested,updatedAt:now()});const updated=await ref.get();return updated.data() as InstallationDoc;}
export async function listInstalledExtensions(userId:string){const snap=await adminDb.collection(COL.installations).where("userId","==",userId).where("status","==","active").limit(100).get();return snap.docs.map(d=>d.data() as InstallationDoc);}
export async function updateInstallationSettings(extensionId:string,userId:string,settings:Record<string,string|number|boolean>){await installationRef(extensionId,userId).update({settings,updatedAt:now()});}

export interface EntitlementDoc{id:string;extensionId:string;userId:string;status:"active"|"expired"|"revoked";source:"free"|"purchase"|"subscription"|"grant";purchaseId?:string|null;expiresAt?:number|null;
/** Renouvellement auto (abonnements uniquement) : activé par défaut, l'utilisateur peut le couper. */
autoRenew?:boolean;
/** Dernier cycle de renouvellement : "ok" débité, "failed" solde insuffisant (grace). */
renewalState?:"ok"|"failed"|null;renewalFailedAt?:number|null;renewalNotice?:string|null;
/** Anti-spam notifications : dernier envoi + compteur (grace → expiration finale). */
lastRenewalAlertAt?:number|null;renewalAlertCount?:number;createdAt:number;updatedAt:number;}
export async function upsertEntitlement(params:{extensionId:string;userId:string;source:EntitlementDoc["source"];purchaseId?:string|null;expiresAt?:number|null;autoRenew?:boolean}){const timestamp=now();const ref=entitlementRef(params.extensionId,params.userId);const existing=await ref.get();const payload:EntitlementDoc={id:`${params.extensionId}__${params.userId}`,extensionId:params.extensionId,userId:params.userId,status:"active",source:params.source,purchaseId:params.purchaseId??null,expiresAt:params.expiresAt??null,
// L'autoRenew est PRÉSERVÉ d'un renouvellement à l'autre : l'utilisateur
// qui a coupé le renouvellement ne doit pas se voir re-débité.
autoRenew:params.autoRenew??(existing.exists?(existing.get("autoRenew")as boolean|undefined)??params.source==="subscription":params.source==="subscription"),createdAt:existing.exists?Number(existing.get("createdAt")):timestamp,updatedAt:timestamp};await ref.set(payload,{merge:true});return payload;}
/** Bascule le renouvellement auto d'un abonnement (réservé au propriétaire via route authentifiée). */
export async function setEntitlementAutoRenew(extensionId:string,userId:string,autoRenew:boolean):Promise<EntitlementDoc>{const ref=entitlementRef(extensionId,userId);const snap=await ref.get();if(!snap.exists)throw new Error("Entitlement not found.");const entitlement=snap.data() as EntitlementDoc;if(entitlement.source!=="subscription")throw new Error("Le renouvellement automatique ne s'applique qu'aux abonnements.");const timestamp=now();await ref.update({autoRenew,updatedAt:timestamp,renewalNotice:null});const updated=await ref.get();return updated.data() as EntitlementDoc;}
/**
 * Abonnements éligibles au renouvellement. Lecture par source (index simple
 * natif) puis filtrage en mémoire — évite tout index composite nouveau
 * (déploiement d'index nécessite le rôle datastore.indexAdmin, indisponible
 * au compte de service ; leçon Task 68).
 */
export async function listSubscriptionEntitlements(scanLimit=200):Promise<EntitlementDoc[]>{const snap=await adminDb.collection(COL.entitlements).where("source","==","subscription").limit(scanLimit).get();return snap.docs.map(d=>d.data() as EntitlementDoc);}
export async function getEntitlement(extensionId:string,userId:string){const snap=await entitlementRef(extensionId,userId).get();return(snap.data() as EntitlementDoc|undefined)??null;}
export async function revokeEntitlement(extensionId:string,userId:string){await entitlementRef(extensionId,userId).update({status:"revoked",updatedAt:now()});}
export interface PurchaseDoc{id:string;userId:string;extensionId:string;version?:string;provider:"wallet"|"chariow";providerRef?:string|null;amountMinor:number;currency:string;status:"pending"|"paid"|"failed"|"refunded";kind:"one_time"|"subscription";createdAt:number;paidAt?:number|null;}
export async function createExtensionPurchase(input:{userId:string;extensionId:string;provider:PurchaseDoc["provider"];amountMinor:number;currency:string;kind:PurchaseDoc["kind"];id?:string}){const ref=input.id?adminDb.collection(COL.purchases).doc(input.id):adminDb.collection(COL.purchases).doc();const payload:PurchaseDoc={id:ref.id,userId:input.userId,extensionId:input.extensionId,provider:input.provider,providerRef:null,amountMinor:input.amountMinor,currency:input.currency,status:"pending",kind:input.kind,createdAt:now(),paidAt:null};await ref.create(payload);return payload;}
export async function getExtensionPurchase(id:string){const snap=await adminDb.collection(COL.purchases).doc(id).get();return(snap.data() as PurchaseDoc|undefined)??null;}
export async function markPurchasePaid(id:string,providerRef:string){const ref=adminDb.collection(COL.purchases).doc(id);await ref.update({status:"paid",providerRef,paidAt:now()});const snap=await ref.get();return snap.data() as PurchaseDoc;}
export async function createLicense(params:{purchaseId:string;userId:string;extensionId:string;licenseKey:string;expiresAt?:number|null}){await adminDb.collection(COL.licenses).doc(params.licenseKey).create({licenseKey:params.licenseKey,purchaseId:params.purchaseId,userId:params.userId,extensionId:params.extensionId,status:"active",expiresAt:params.expiresAt??null,createdAt:now()});}
export async function listPurchasesByUser(userId:string,limit=50){const snap=await adminDb.collection(COL.purchases).where("userId","==",userId).orderBy("createdAt","desc").limit(limit).get();return snap.docs.map(d=>d.data() as PurchaseDoc);}
export interface ReviewDoc{id:string;extensionId:string;userId:string;rating:number;title?:string|null;body:string;status:"visible"|"hidden";developerReply?:{body:string;at:number}|null;createdAt:number;updatedAt:number;deletedAt?:number|null;}
export async function upsertReview(params:{extensionId:string;userId:string;rating:number;title?:string;body:string}){const timestamp=now();const ref=adminDb.collection(COL.reviews).doc(`${params.extensionId}__${params.userId}`);await adminDb.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists){const previous=snap.data() as ReviewDoc;tx.update(ref,{rating:params.rating,title:params.title??null,body:params.body.slice(0,4000),updatedAt:timestamp});tx.update(extensionRef(params.extensionId),{"stats.ratingSum":FieldValue.increment(params.rating-previous.rating),updatedAt:timestamp});return;}tx.create(ref,{id:ref.id,extensionId:params.extensionId,userId:params.userId,rating:params.rating,title:params.title??null,body:params.body.slice(0,4000),status:"visible",createdAt:timestamp,updatedAt:timestamp,deletedAt:null});tx.update(extensionRef(params.extensionId),{"stats.ratingSum":FieldValue.increment(params.rating),"stats.ratingCount":FieldValue.increment(1),updatedAt:timestamp});});}
export async function listReviews(extensionId:string,limit=20){const snap=await adminDb.collection(COL.reviews).where("extensionId","==",extensionId).where("status","==","visible").orderBy("createdAt","desc").limit(limit).get();return snap.docs.map(d=>d.data() as ReviewDoc);}

/* ── Catalogue paginé (marketplace avancé) ───────────────────────────────────
 * UNE SEULE forme de requête Firestore (equality status+deletedAt, plafond
 * 200) → tri en mémoire par clé de tri avec départage par identifiant
 * (déterministe). Le curseur opaque encode {k,id} de la dernière fiche : le
 * serveur reprend APRÈS cette fiche (keyset), stable face aux insertions.
 * `truncated:true` signale honnêtement qu'un dépôt >200 fiches n'est pas
 * paginé au-delà (l'ancienne API était déjà limitée à 100 sans pagination). */
export type CatalogSort = "popular" | "newest" | "price_asc" | "rating";
const CATALOG_SCAN_CAP = 200;

function encodeCursor(value: { k: number | string; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(raw: string | undefined): { k: number | string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { k?: unknown; id?: unknown };
    if (typeof parsed.id !== "string" || !parsed.id || (typeof parsed.k !== "number" && typeof parsed.k !== "string")) return null;
    return { k: parsed.k as number | string, id: parsed.id };
  } catch {
    throw new Error("Curseur de catalogue invalide.");
  }
}

function ratingOf(doc: ExtensionDoc): number {
  return doc.stats.ratingCount > 0 ? doc.stats.ratingSum / doc.stats.ratingCount : 0;
}

export async function listApprovedCatalogPage(options: {
  q?: string; category?: string; limit?: number; sort?: CatalogSort; cursor?: string;
}): Promise<{ docs: ExtensionDoc[]; nextCursor: string | null; truncated: boolean; sort: CatalogSort }> {
  const sort: CatalogSort = options.sort ?? "popular";
  const limit = Math.min(Math.max(options.limit ?? 48, 1), 100);
  let query: FirebaseFirestore.Query = adminDb.collection(COL.extensions)
    .where("status", "==", "approved").where("deletedAt", "==", null).limit(CATALOG_SCAN_CAP);
  if (options.category) query = query.where("category", "==", options.category);
  const snap = await query.get();
  let docs = snap.docs.map((d) => d.data() as ExtensionDoc);
  if (docs.length >= CATALOG_SCAN_CAP) docs.sort((a, b) => a.id.localeCompare(b.id)); // fenêtre déterministe au cap
  const needle = options.q?.trim().toLowerCase();
  if (needle) docs = docs.filter((d) => d.name.toLowerCase().includes(needle) || d.description.toLowerCase().includes(needle) || d.tags.some((t) => t.toLowerCase().includes(needle)));

  const keyOf = (doc: ExtensionDoc): number | string => {
    switch (sort) {
      case "newest": return doc.createdAt ?? 0;
      case "price_asc": return doc.pricing?.amountMinor ?? 0;
      case "rating": return ratingOf(doc);
      case "popular": default: return doc.stats?.installs ?? 0;
    }
  };
  const ascending = sort === "price_asc";
  docs.sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return (ascending ? cmp : -cmp) || a.id.localeCompare(b.id);
  });

  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    const idx = docs.findIndex((d) => d.id === cursor.id && keyOf(d) === cursor.k);
    if (idx >= 0) docs = docs.slice(idx + 1);
    else throw new Error("Curseur de catalogue invalide.");
  }
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = docs.length > page.length;
  return {
    docs: page,
    nextCursor: last && hasMore ? encodeCursor({ k: keyOf(last), id: last.id }) : null,
    truncated: snap.size >= CATALOG_SCAN_CAP,
    sort,
  };
}

/* ── Réponses développeur aux avis + modération admin ─────────────────────── */
function reviewRef(reviewId: string) { return adminDb.collection(COL.reviews).doc(reviewId); }

export async function getReviewById(reviewId: string): Promise<ReviewDoc | null> {
  const snap = await reviewRef(reviewId).get();
  return (snap.data() as ReviewDoc | undefined) ?? null;
}

/** Le DÉVELOPPEUR de l'extension répond publiquement à un avis visible. */
export async function replyToReview(params: { extensionId: string; developerId: string; reviewId: string; reply: string }): Promise<ReviewDoc> {
  const extension = await getExtension(params.extensionId);
  if (!extension) throw new Error("Extension introuvable.");
  if (extension.developerId !== params.developerId) throw new Error("Seul le développeur de l'extension peut répondre aux avis.");
  const ref = reviewRef(params.reviewId);
  const snap = await ref.get();
  const review = snap.data() as ReviewDoc | undefined;
  if (!review || review.extensionId !== params.extensionId) throw new Error("Avis introuvable.");
  if (review.status !== "visible") throw new Error("Cet avis n'est pas visible.");
  const body = params.reply.trim().slice(0, 2000);
  if (body.length < 2) throw new Error("La réponse doit contenir au moins 2 caractères.");
  await ref.update({ developerReply: { body, at: now() }, updatedAt: now() });
  const updated = await ref.get();
  return updated.data() as ReviewDoc;
}

/** Modération admin : masquer / réafficher un avis (les stats suivent le
 * statut — une fiche masquée ne compte plus dans la moyenne). */
export async function moderateReview(params: { reviewId: string; action: "hide" | "show" }): Promise<ReviewDoc> {
  const ref = reviewRef(params.reviewId);
  const snap = await ref.get();
  const review = snap.data() as ReviewDoc | undefined;
  if (!review) throw new Error("Avis introuvable.");
  const wasVisible = review.status === "visible";
  const willBeVisible = params.action === "show";
  if (wasVisible === willBeVisible) return review; // idempotent
  await adminDb.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    const current = fresh.data() as ReviewDoc | undefined;
    if (!current) throw new Error("Avis introuvable.");
    const stillVisible = current.status === "visible";
    tx.update(ref, { status: willBeVisible ? "visible" : "hidden", updatedAt: now() });
    const delta = stillVisible === willBeVisible ? 0 : willBeVisible ? 1 : -1;
    if (delta !== 0) {
      tx.update(extensionRef(current.extensionId), {
        "stats.ratingSum": FieldValue.increment(delta * current.rating),
        "stats.ratingCount": FieldValue.increment(delta),
        updatedAt: now(),
      });
    }
  });
  const extension = await getExtension(review.extensionId);
  if (extension) {
    const avg = extension.stats.ratingCount > 0
      ? Math.round((extension.stats.ratingSum / extension.stats.ratingCount) * 100) / 100
      : 0;
    await extensionRef(review.extensionId).update({ "stats.ratingAvg": avg, updatedAt: now() }).catch(() => undefined);
  }
  const updated = await ref.get();
  return updated.data() as ReviewDoc;
}
export async function createReport(params:{extensionId:string;userId:string;reason:string;details?:string}){await adminDb.collection(COL.reports).add({extensionId:params.extensionId,userId:params.userId,reason:params.reason.slice(0,200),details:params.details?.slice(0,2000)??null,status:"open",createdAt:now()});}
export async function recordExtensionExecution(params:{extensionId:string;version:string;userId:string;toolId:string;ok:boolean;status:string;durationMs:number;error?:string;executionId?:string}){const timestamp=now();await Promise.all([adminDb.collection(COL.executions).add({extensionId:params.extensionId,version:params.version,userId:params.userId,toolId:params.toolId,ok:params.ok,status:params.status,durationMs:params.durationMs,error:params.error?.slice(0,1000)??null,executionId:params.executionId??null,createdAt:timestamp}),adminDb.collection(COL.usage).doc(`${params.extensionId}__${params.userId}__${new Date(timestamp).toISOString().slice(0,10)}`).set({extensionId:params.extensionId,userId:params.userId,day:new Date(timestamp).toISOString().slice(0,10),executions:FieldValue.increment(1),updatedAt:timestamp},{merge:true}),extensionRef(params.extensionId).update({"stats.executions":FieldValue.increment(1),updatedAt:timestamp})]);}
export async function getUsageCounter(extensionId:string,userId:string,day:string){const snap=await adminDb.collection(COL.usage).doc(`${extensionId}__${userId}__${day}`).get();return snap.data()??null;}
export async function listExecutions(extensionId:string,userId:string,limit=50){const snap=await adminDb.collection(COL.executions).where("extensionId","==",extensionId).where("userId","==",userId).orderBy("createdAt","desc").limit(Math.min(limit,100)).get();return snap.docs.map(d=>d.data());}
export async function addDeveloperRevenue(params:{developerId:string;extensionId:string;purchaseId:string;grossAmountMinor:number;currency:string}){const split=computeRevenueSplit(params.grossAmountMinor);await adminDb.collection(COL.revenue).add({developerId:params.developerId,extensionId:params.extensionId,purchaseId:params.purchaseId,grossAmountMinor:split.grossAmountMinor,feeMinor:split.feeMinor,netAmountMinor:split.netAmountMinor,currency:params.currency,createdAt:now()});}

// --- Fonctions restaurees (perdues lors de la reecriture d7a9046) ---

export async function listExtensionExecutions(params: {
  projectId?: string;
  extensionId: string;
  userId?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  let query: FirebaseFirestore.Query = adminDb
    .collection(COL.executions)
    .where("extensionId", "==", params.extensionId);
  if (params.userId) query = query.where("userId", "==", params.userId);
  if (params.projectId) {
    const extension = await getExtension(params.extensionId);
    if (!extension || extension.projectId !== params.projectId) throw new Error("Extension is not linked to this Gen3ia project.");
  }
  const snap = await query.orderBy("createdAt", "desc").limit(Math.min(params.limit ?? 50, 200)).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/** Consumes one execution slot from the daily counter; throws when exceeded. */
export async function consumeExecutionQuota(params: {
  userId: string;
  extensionId: string;
  maxPerDay: number;
}): Promise<{ used: number }> {
  const ref = adminDb
    .collection(COL.usage)
    .doc(`${params.userId}__${params.extensionId}__${new Date().toISOString().slice(0, 10)}`);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = Number(snap.get("count") ?? 0);
    if (used >= params.maxPerDay) {
      throw new Error(`Daily execution quota reached for this extension (${params.maxPerDay}/day).`);
    }
    tx.set(ref, { count: used + 1, userId: params.userId, extensionId: params.extensionId }, { merge: true });
    return { used: used + 1 };
  });
}

export async function assertExtensionProject(extensionId:string,developerId:string,projectId:string):Promise<ExtensionDoc>{const extension=await getExtension(extensionId);if(!extension)throw new Error("Extension not found.");if(extension.developerId!==developerId||extension.projectId!==projectId)throw new Error("Extension is not linked to this Gen3ia project.");return extension;}

export async function setExtensionSecret(extensionId: string, ref: string, value: string, developerId?:string, projectId?:string): Promise<void> {
  if(developerId&&projectId) await assertExtensionProject(extensionId,developerId,projectId);
  await adminDb.collection(COL.secrets).doc(`${extensionId}__${ref}`).set({
    extensionId,
    ref,
    // Chiffré au repos (AES-256-GCM, SECRETS_ENVELOPE_KEY) — déchiffré
    // uniquement à l'injection runtime.
    value: encryptSecret(value),
    updatedAt: now(),
  });
}

export async function getExtensionSecrets(extensionId: string, developerId?: string, projectId?: string): Promise<Record<string, string>> {
  if (developerId && projectId) await assertExtensionProject(extensionId, developerId, projectId);
  const snap = await adminDb.collection(COL.secrets).where("extensionId", "==", extensionId).get();
  const secrets: Record<string, string> = {};
  for (const doc of snap.docs) secrets[String(doc.get("ref"))] = decryptSecret(String(doc.get("value") ?? ""));
  return secrets;
}

export async function listExtensionSecretRefs(extensionId: string, developerId?: string, projectId?: string): Promise<string[]> {
  if (developerId && projectId) await assertExtensionProject(extensionId, developerId, projectId);
  const snap = await adminDb.collection(COL.secrets).where("extensionId", "==", extensionId).get();
  return snap.docs.map((doc) => String(doc.get("ref")));
}

export async function deleteExtensionSecret(extensionId: string, ref: string, developerId?: string, projectId?: string): Promise<void> {
  if (developerId && projectId) await assertExtensionProject(extensionId, developerId, projectId);
  await adminDb.collection(COL.secrets).doc(`${extensionId}__${ref}`).delete();
}

/**
 * Revenus nets cumulés d'un développeur pour une devise donnée — agrégation
 * Firestore côté serveur (sum) : le volume d'entrées ne dégrade pas la page.
 * Les filtres égalitaires (developerId + currency) s'appuient sur les index
 * simples natifs, aucun index composite requis. Les entrées de revenus sont
 * append-only : une valeur légèrement périmée est CONSERVATRICE (sous-estime
 * le gagné, jamais le sur-estime) — propriété exploitable par les retraits.
 */
export async function sumDeveloperNetEarnings(developerId: string, currency: string): Promise<number> {
  const snapshot = await adminDb
    .collection(COL.revenue)
    .where("developerId", "==", developerId)
    .where("currency", "==", currency)
    .aggregate({ totalNetMinor: AggregateField.sum("netAmountMinor") })
    .get();
  const value = Number(snapshot.data().totalNetMinor ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** Stats de retraits d'un développeur (source d'autorité du montant engagé). */
export interface DeveloperPayoutStatsDoc{developerId:string;payoutCount:number;committedMinor:number;currency:string;lastPayoutAt?:number|null;updatedAt:number;}
export function developerPayoutStatsRef(developerId:string){return adminDb.collection(COL.payoutStats).doc(developerId);}
export async function getDeveloperPayoutStats(developerId:string):Promise<DeveloperPayoutStatsDoc|null>{const snap=await developerPayoutStatsRef(developerId).get();return(snap.data() as DeveloperPayoutStatsDoc|undefined)??null;}

/** Demande de retrait d'un développeur (lecture seule ici — écriture transactionnelle dans payouts.ts). */
export interface PayoutDoc{id:string;developerId:string;amountMinor:number;currency:string;method:"mtn_momo"|"orange_money"|"bank_transfer";methodDetail:{accountName:string;accountNumber:string;bankName?:string|null;country:string};status:"requested"|"approved"|"paid"|"rejected";developerNote?:string|null;adminNote?:string|null;providerRef?:string|null;requestedAt:number;decidedAt?:number|null;paidAt?:number|null;updatedAt:number;}
export function payoutRef(payoutId:string){return adminDb.collection(COL.payouts).doc(payoutId);}
export async function getPayoutDoc(payoutId:string):Promise<PayoutDoc|null>{const snap=await payoutRef(payoutId).get();return(snap.data() as PayoutDoc|undefined)??null;}
export async function listPayoutsByDeveloper(developerId:string,limit=50):Promise<PayoutDoc[]>{const snap=await adminDb.collection(COL.payouts).where("developerId","==",developerId).orderBy("requestedAt","desc").limit(limit).get();return snap.docs.map(d=>d.data() as PayoutDoc);}
/** File admin : demandes à traiter (requested/approved) ou tout statut fourni. */
export async function listPayoutsByStatus(statuses:PayoutDoc["status"][],limit=100):Promise<PayoutDoc[]>{const snap=await adminDb.collection(COL.payouts).where("status","in",statuses).orderBy("requestedAt","asc").limit(limit).get();return snap.docs.map(d=>d.data() as PayoutDoc);}

export async function getDeveloperRevenueSummary(developerId: string): Promise<{
  totalGrossMinor: number;
  totalFeeMinor: number;
  totalNetMinor: number;
  currency: string;
  entries: number;
}> {
  const snap = await adminDb
    .collection(COL.revenue)
    .where("developerId", "==", developerId)
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();
  let totalGrossMinor = 0;
  let totalFeeMinor = 0;
  let totalNetMinor = 0;
  let currency = "XAF";
  for (const doc of snap.docs) {
    totalGrossMinor += Number(doc.get("grossAmountMinor") ?? 0);
    totalFeeMinor += Number(doc.get("feeMinor") ?? 0);
    totalNetMinor += Number(doc.get("netAmountMinor") ?? 0);
    currency = String(doc.get("currency") ?? currency);
  }
  return { totalGrossMinor, totalFeeMinor, totalNetMinor, currency, entries: snap.size };
}

export async function createDeveloperApiKey(params: {
  userId: string;
  keyHash: string;
  prefix: string;
  name: string;
  projectId: string;
}): Promise<void> {
  await adminDb.collection(COL.apiKeys).doc(params.keyHash).create({
    keyHash: params.keyHash,
    prefix: params.prefix,
    name: params.name.slice(0, 100),
    userId: params.userId,
    projectId: params.projectId,
    status: "active",
    createdAt: now(),
    lastUsedAt: null,
    revokedAt: null,
  });
}

export async function getDeveloperApiKey(keyHash: string) {
  const snap = await adminDb.collection(COL.apiKeys).doc(keyHash).get();
  if (!snap.exists) return null;
  if (snap.get("status") !== "active" || snap.get("revokedAt") || !snap.get("projectId")) return null;
  return snap.data() as { userId: string; prefix: string; name: string; projectId: string };
}

export async function verifyDeveloperProjectAccess(userId: string, projectId: string): Promise<void> {
  const snap = await adminDb.collection("developerProjects").doc(projectId).get();
  if (!snap.exists || snap.get("ownerId") !== userId || snap.get("status") !== "active") {
    throw new Error("Projet Gen3ia introuvable ou non lié à ce compte.");
  }
}

export async function getDeveloperProjectResourceSummary(userId:string,projectId:string){
  await verifyDeveloperProjectAccess(userId,projectId);
  const [extensionsSnap,keysSnap]=await Promise.all([
    adminDb.collection(COL.extensions).where("developerId","==",userId).where("projectId","==",projectId).where("deletedAt","==",null).limit(100).get(),
    adminDb.collection(COL.apiKeys).where("userId","==",userId).where("projectId","==",projectId).where("status","==","active").limit(100).get(),
  ]);
  const extensions=extensionsSnap.docs.map(d=>d.data() as ExtensionDoc);
  const executions=extensions.reduce((n,e)=>n+Number(e.stats?.executions??0),0);
  const installations=extensions.reduce((n,e)=>n+Number(e.stats?.installs??0),0);
  return {projectId,resources:{extensions:extensions.length,activeApiKeys:keysSnap.size,executions,installations,approvedExtensions:extensions.filter(e=>e.status==="approved").length,draftExtensions:extensions.filter(e=>e.status==="draft").length},extensionIds:extensions.map(e=>e.id)};
}

export async function listDeveloperApiKeys(userId: string) {
  const snap = await adminDb
    .collection(COL.apiKeys)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  return snap.docs.map((doc) => ({
    prefix: String(doc.get("prefix")),
    name: String(doc.get("name")),
    status: String(doc.get("status")),
    createdAt: Number(doc.get("createdAt")),
    projectId: doc.get("projectId") ? String(doc.get("projectId")) : null,
  }));
}

export async function revokeDeveloperApiKey(keyHash: string, userId: string): Promise<void> {
  await adminDb.collection(COL.apiKeys).doc(keyHash).update({ status: "revoked", revokedAt: now(), userId });
}

/** Revokes by visible prefix — used by the Developer Studio UI where the plaintext key is unknown. */
export async function revokeDeveloperApiKeyByPrefix(prefix: string, userId: string): Promise<void> {
  const snap = await adminDb
    .collection(COL.apiKeys)
    .where("userId", "==", userId)
    .where("prefix", "==", prefix)
    .where("status", "==", "active")
    .limit(2)
    .get();
  if (snap.empty) throw new Error("Clé SDK active introuvable pour ce préfixe.");
  if (snap.size > 1) throw new Error("Préfixe ambigu ; révoquez la clé complète.");
  await snap.docs[0].ref.update({ status: "revoked", revokedAt: now(), userId });
}
