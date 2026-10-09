import "server-only";

import { FsTimestamp, isSentinel, compareValeurs, comparable, depuisStockage, type SentinelKind } from "./serialization";
import { collectionPrefix, docKey, parseKey } from "./keys";
import { FsError, isConflictError, rawDelete, rawGet, rawListKeys, rawPut, type RawDocSnapshot } from "./store";

/**
 * MIGRATION R2 TOTALE — moteur r2fs (facade Firestore-like).
 *
 * Implémente la surface Firestore consommée par le projet, au-dessus du
 * store CAS (store.ts) :
 *   db.collection(path)          → FsCollection (doc/add/where/orderBy/limit/get/aggregate/count)
 *   ref.get/set/update/delete    → snapshots + écritures atomiques (CAS-retry)
 *   db.runTransaction(fn)        → reads enregistrés + commit CAS conditionnel,
 *                                  retry complet sur conflit 412
 *   db.batch()                   → FsWriteBatch (commit séquentiel, CAS par doc)
 *   db.collectionGroup(id)       → requête transversale (collections racine ET imbriquées)
 *
 * Sémantique héritée de Firestore (pour ne PAS toucher les ~55 appelants) :
 *   - get sur doc absent → snapshot.exists=false (jamais d'exception) ;
 *   - update sur doc absent → FsError("not_found") « No document to update » ;
 *   - update crée les champs manquants ; clés pointées « a.b » supportées ;
 *   - FieldValue.increment résout contre la valeur lue (0 si absent) ;
 *   - set({merge:true}) fusionne au premier niveau ; FieldValue.delete()
 *     interdit dans un set() écrasant (comme Firestore) ;
 *   - serverTimestamp → horodatage du commit (millisecondes) ;
 *   - ref.parent / doc.ref.parent.parent?.id (collections imbriquées).
 *
 * Limites assumées (documentées dans worklog.md) :
 *   - requêtes = scan préfixe + filtre mémoire (plafond 2000 docs) ;
 *   - FieldValue.increment DANS un set() écrasant résout contre un doc vide
 *     (Firestore relirait la version serveur) — le projet l'utilise
 *     uniquement en merge/update ;
 *   - batch : atomicité par document (pas inter-documents).
 */

/* ------------------------------------------------------------------ */
/* Identifiants de documents                                           */
/* ------------------------------------------------------------------ */

const DOC_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Identifiant aléatoire type Firestore (20 caractères base62) pour doc() sans argument. */
function newDocId(): string {
  let id = "";
  for (let i = 0; i < 20; i += 1) {
    const alea = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    id += DOC_ID_ALPHABET[alea % DOC_ID_ALPHABET.length];
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Accès aux champs (chemins pointés)                                  */
/* ------------------------------------------------------------------ */

function champAu(data: Record<string, unknown> | null, field: string): unknown {
  if (!data) return undefined;
  if (!field.includes(".")) return data[field];
  let curseur: unknown = data;
  for (const segment of field.split(".")) {
    if (curseur === null || typeof curseur !== "object" || Array.isArray(curseur)) return undefined;
    curseur = (curseur as Record<string, unknown>)[segment];
  }
  return curseur;
}

function poseChamp(cible: Record<string, unknown>, field: string, valeur: unknown): void {
  if (!field.includes(".")) {
    cible[field] = valeur;
    return;
  }
  const segments = field.split(".");
  let curseur: Record<string, unknown> = cible;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const suivant = curseur[segment];
    if (suivant === null || typeof suivant !== "object" || Array.isArray(suivant)) {
      if (suivant !== undefined) {
        throw new FsError("failed_precondition", `r2fs: champ « ${segments.slice(0, i + 1).join(".")} » n'est pas une carte (chemin pointé ${field}).`);
      }
      curseur[segment] = {};
    }
    curseur = curseur[segment] as Record<string, unknown>;
  }
  curseur[segments[segments.length - 1]] = valeur;
}

function retireChamp(cible: Record<string, unknown>, field: string): void {
  if (!field.includes(".")) {
    delete cible[field];
    return;
  }
  const segments = field.split(".");
  let curseur: unknown = cible;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (curseur === null || typeof curseur !== "object" || Array.isArray(curseur)) return;
    curseur = (curseur as Record<string, unknown>)[segments[i]];
  }
  if (curseur !== null && typeof curseur === "object" && !Array.isArray(curseur)) {
    delete (curseur as Record<string, unknown>)[segments[segments.length - 1]];
  }
}

/** Détecte un conflit « a » et « a.b » dans un patch (Firestore le refuse). */
function assertPasDeConflitDeChemins(keys: string[]): void {
  const ensemble = new Set(keys);
  for (const key of keys) {
    if (!key.includes(".")) continue;
    const segments = key.split(".");
    for (let i = 1; i < segments.length; i += 1) {
      if (ensemble.has(segments.slice(0, i).join("."))) {
        throw new FsError("invalid_argument", `r2fs: champs concurrents « ${key} » et préfixe (patch ambigu).`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Résolution des sentinelles FieldValue                               */
/* ------------------------------------------------------------------ */

const ABSENT: unique symbol = Symbol("r2fs-absent");

/** Carte ordinaire éligible à la résolution récursive (ni sentinelle, ni tableau, ni Timestamp/Date). */
function estCarteOrdinaire(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof FsTimestamp) &&
    !(v instanceof Date)
  );
}

/** Détecte une sentinelle FieldValue à N'IMPORTE QUELLE profondeur (cartes et tableaux). */
function contientSentinelle(v: unknown): boolean {
  if (isSentinel(v)) return true;
  if (Array.isArray(v)) return v.some(contientSentinelle);
  if (estCarteOrdinaire(v)) return Object.values(v).some(contientSentinelle);
  return false;
}

interface ResolutionRec {
  valeur: unknown;
  /** true = champ à retirer (FieldValue.delete() résolu). */
  absent: boolean;
}

/**
 * Résout RÉCURSIVEMENT une valeur de patch : sentinelles à toute profondeur
 * (comme Firestore, qui accepte { carte: { champ: FieldValue.increment(x) } }),
 * tableaux refusant toute sentinelle (contrat Firestore), cartes imbriquées
 * parcourues en construisant le chemin pointé correspondant (champ lu contre
 * l'état actuel du doc — `courant` — au chemin complet).
 */
function resoudreValeurRec(
  courant: Record<string, unknown> | null,
  chemin: string,
  valeur: unknown,
  nowMs: number,
  mode: "set" | "merge",
): ResolutionRec {
  if (isSentinel(valeur)) {
    const resolu = resoudreSentinelle(mode === "set" ? null : courant, chemin, valeur, nowMs, mode);
    return resolu === ABSENT ? { valeur: undefined, absent: true } : { valeur: resolu, absent: false };
  }
  if (Array.isArray(valeur)) {
    if (valeur.some(contientSentinelle)) {
      throw new FsError("invalid_argument", `r2fs: FieldValue interdit dans un tableau (${chemin}) — Firestore le refuse aussi.`);
    }
    return { valeur, absent: false };
  }
  if (estCarteOrdinaire(valeur)) {
    const sortie: Record<string, unknown> = {};
    for (const [cle, v] of Object.entries(valeur)) {
      if (v === undefined) continue; // ignoreUndefinedProperties
      const resolu = resoudreValeurRec(courant, `${chemin}.${cle}`, v, nowMs, mode);
      if (resolu.absent) continue; // delete imbriqué → clé absente de la carte entrante
      sortie[cle] = resolu.valeur;
    }
    return { valeur: sortie, absent: false };
  }
  return { valeur, absent: false };
}

function resoudreSentinelle(
  courant: Record<string, unknown> | null,
  key: string,
  sentinelle: SentinelKind,
  nowMs: number,
  mode: "set" | "merge",
): unknown {
  switch (sentinelle.__fs_sentinel__) {
    case "serverTimestamp":
      return new FsTimestamp(nowMs);
    case "delete":
      if (mode === "set") {
        throw new FsError("invalid_argument", "r2fs: FieldValue.delete() interdit dans un set() écrasant (utiliser {merge:true} ou update).");
      }
      return ABSENT;
    case "increment": {
      const actuel = champAu(courant, key);
      if (actuel === undefined || actuel === null) return sentinelle.operand;
      if (typeof actuel !== "number") {
        throw new FsError("failed_precondition", `r2fs: increment sur un champ non numérique (${key}).`);
      }
      return actuel + sentinelle.operand;
    }
    case "arrayUnion": {
      const actuel = champAu(courant, key);
      const tableau = Array.isArray(actuel) ? [...actuel] : [];
      for (const valeur of sentinelle.values) {
        if (!tableau.some((item) => compareValeurs(item, valeur) === 0)) tableau.push(valeur);
      }
      return tableau;
    }
    case "arrayRemove": {
      const actuel = champAu(courant, key);
      if (!Array.isArray(actuel)) return ABSENT;
      return actuel.filter((item) => !sentinelle.values.some((v) => compareValeurs(item, v) === 0));
    }
  }
}

/**
 * Applique `patch` sur `courant` (null = doc absent) et retourne le doc
 * résultant. Mode « set » (écrasement) : part de zéro. Mode merge : copie du
 * courant + pose/retrait par chemins pointés + résolution des sentinelles.
 * Les sentinelles sont résolues À TOUTE PROFONDEUR (cartes imbriquées —
 * sémantique Firestore ; ex. { stats: { billedMinor: FieldValue.increment() } }).
 */
function resoudrePatch(
  courant: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  nowMs: number,
  mode: "set" | "merge",
): Record<string, unknown> {
  const base: Record<string, unknown> = mode === "set" ? {} : (courant === null ? {} : (depuisStockage(courant) as Record<string, unknown>));
  const keys = Object.keys(patch).sort();
  assertPasDeConflitDeChemins(keys);

  for (const key of keys) {
    const resolu = resoudreValeurRec(courant, key, patch[key], nowMs, mode);
    if (resolu.absent) {
      retireChamp(base, key);
      continue;
    }
    if (resolu.valeur === undefined) continue; // ignoreUndefinedProperties
    poseChamp(base, key, resolu.valeur);
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin : DocumentData est any-valué (dot-access héritée du projet)
export type FsDocumentData = { [field: string]: any };

export class FsDocSnapshot {
  constructor(
    readonly ref: FsDocRef,
    protected readonly raw: RawDocSnapshot,
  ) {}

  get id(): string {
    return this.ref.id;
  }

  get exists(): boolean {
    return this.raw.exists;
  }

  /** Sémantique DocumentSnapshot Firestore : undefined si le doc n'existe pas. */
  data(): FsDocumentData | undefined {
    return (this.raw.exists && this.raw.data ? (this.raw.data as FsDocumentData) : undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin : get(field) retourne any
  get(field: string): any {
    return champAu(this.raw.data, field);
  }
}

/**
 * Document D'UNE requête (sémantique QueryDocumentSnapshot) : le doc existe
 * TOUJOURS — data() ne retourne jamais undefined (contrat firebase-admin).
 */
export class FsQueryDocSnapshot extends FsDocSnapshot {
  override data(): FsDocumentData {
    return this.raw.data as FsDocumentData;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin
  override get(field: string): any {
    return champAu(this.raw.data, field);
  }
}

export class FsQuerySnapshot {
  /** Les documents d'une requête existent TOUJOURS (QueryDocumentSnapshot). */
  constructor(readonly docs: FsQueryDocSnapshot[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }

  forEach(cb: (doc: FsDocSnapshot) => void): void {
    this.docs.forEach(cb);
  }
}

/* ------------------------------------------------------------------ */
/* Références de documents et collections                              */
/* ------------------------------------------------------------------ */

export class FsDocRef {
  constructor(
    private readonly engine: R2Fs,
    readonly collectionPath: string[],
    readonly id: string,
  ) {}

  get path(): string {
    return [...this.collectionPath, this.id].join("/");
  }

  /** Collection parente d'une sous-collection ; null pour une racine. */
  get parent(): FsCollection {
    return new FsCollection(this.engine, this.collectionPath);
  }

  collection(nom: string): FsCollection {
    return new FsCollection(this.engine, [...this.collectionPath, this.id, ...nom.split("/").filter(Boolean)]);
  }

  async get(): Promise<FsDocSnapshot> {
    const raw = await rawGet(this.collectionPath, this.id);
    return new FsDocSnapshot(this, raw);
  }

  /** Écriture écrasante (ou fusion avec {merge:true}). Atomique par CAS-retry. */
  async set(data: FsDocumentData, opts?: { merge?: boolean }): Promise<void> {
    if (opts?.merge) {
      await this.engine.mergeLoop(this.collectionPath, this.id, data, { requireExisting: false });
      return;
    }
    await rawPut(this.collectionPath, this.id, resoudrePatch(null, data, Date.now(), "set"));
  }

  /** Mise à jour partielle : le doc DOIT exister. Atomique par CAS-retry. */
  async update(data: FsDocumentData): Promise<void> {
    await this.engine.mergeLoop(this.collectionPath, this.id, data, { requireExisting: true });
  }

  /** Création stricte (Firestore create) : échoue si le doc existe déjà. */
  async create(data: FsDocumentData): Promise<void> {
    const resolu = resoudrePatch(null, data, Date.now(), "set");
    try {
      await rawPut(this.collectionPath, this.id, resolu, { createOnly: true });
    } catch (error) {
      if (isConflictError(error)) {
        throw new FsError("already_exists", `r2fs: document déjà existant (${this.path})`);
      }
      throw error;
    }
  }

  async delete(): Promise<void> {
    await rawDelete(this.collectionPath, this.id);
  }
}


/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */

export type WhereOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "array-contains";

interface FilterSpec {
  field: string;
  op: WhereOp;
  valeur: unknown;
}

interface OrderSpec {
  field: string;
  direction: "asc" | "desc";
}

interface Cible {
  kind: "collection" | "group";
  path: string[];
  /** Nom de collection groupée (kind=group). */
  group?: string;
}

const FS_QUERY_SCAN_CAP = 2000;
const FS_CONCURRENCY = 10;

/** Spec d'agrégation accepté : forme moteur OU sentinelles AggregateField. */
export type AggSpecIn = Record<string, { sum?: string; count?: boolean; avg?: string } | { __fs_agg__: "sum" | "count" | "avg"; field?: string }>;

function normaliseSpec(spec: AggSpecIn): Record<string, { sum?: string; count?: boolean; avg?: string }> {
  const sortie: Record<string, { sum?: string; count?: boolean; avg?: string }> = {};
  for (const [alias, valeur] of Object.entries(spec)) {
    const agg = valeur as { __fs_agg__?: "sum" | "count" | "avg"; field?: string; sum?: string; count?: boolean; avg?: string };
    if (agg.__fs_agg__ === "sum") sortie[alias] = { sum: agg.field };
    else if (agg.__fs_agg__ === "count") sortie[alias] = { count: true };
    else if (agg.__fs_agg__ === "avg") sortie[alias] = { avg: agg.field };
    else sortie[alias] = agg as { sum?: string; count?: boolean; avg?: string };
  }
  return sortie;
}

export class FsAggregation {
  constructor(
    private readonly engine: R2Fs,
    private readonly cible: Cible,
    private readonly filters: FilterSpec[],
    spec: AggSpecIn,
  ) {
    this.spec = normaliseSpec(spec);
  }

  private readonly spec: Record<string, { sum?: string; count?: boolean; avg?: string }>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin : data() d'agrégation loose (count/sum = number, avg peut être null)
  async get(): Promise<{ data(): Record<string, any> }> {
    const docs = await this.engine.scanDocs(this.cible, this.filters);
    const sortie: Record<string, number | null> = {};
    for (const [alias, agg] of Object.entries(this.spec)) {
      if (agg.count) {
        // Contrat Firestore : count est TOUJOURS un number (jamais null).
        sortie[alias] = docs.length;
      } else if (agg.sum) {
        let somme = 0;
        for (const doc of docs) {
          const v = champAu(doc, agg.sum);
          if (typeof v === "number" && Number.isFinite(v)) somme += v;
        }
        // Contrat Firestore : sum = number même sans entrée.
        sortie[alias] = somme;
      } else if (agg.avg) {
        let somme = 0;
        let n = 0;
        for (const doc of docs) {
          const v = champAu(doc, agg.avg);
          if (typeof v === "number" && Number.isFinite(v)) {
            somme += v;
            n += 1;
          }
        }
        sortie[alias] = n === 0 ? null : somme / n;
      } else {
        sortie[alias] = null;
      }
    }
    return { data: () => sortie };
  }
}

export class FsQuery<T = FsDocumentData, _Db = T> {
  protected readonly engine: R2Fs;
  private readonly cible: Cible;
  private filters: FilterSpec[] = [];
  private orders: OrderSpec[] = [];
  private limitVal: number | undefined;
  private selectFields: string[] | undefined;

  constructor(
    engine: R2Fs,
    cible: Cible,
  ) {
    this.engine = engine;
    this.cible = cible;
  }

  where(field: string, op: WhereOp, valeur: unknown): FsQuery<T> {
    const q = this.clone();
    q.filters = [...this.filters, { field, op, valeur }];
    return q;
  }

  orderBy(field: string, direction: "asc" | "desc" = "asc"): FsQuery<T> {
    const q = this.clone();
    q.orders = [...this.orders, { field, direction }];
    return q;
  }

  limit(n: number): FsQuery<T> {
    const q = this.clone();
    q.limitVal = n;
    return q;
  }

  select(...fields: string[]): FsQuery<T> {
    const q = this.clone();
    q.selectFields = fields;
    return q;
  }

  count(): FsAggregation {
    return new FsAggregation(this.engine, this.cible, this.filters, { count: { count: true } });
  }

  aggregate(spec: AggSpecIn): FsAggregation {
    return new FsAggregation(this.engine, this.cible, this.filters, spec);
  }

  async get(): Promise<FsQuerySnapshot> {
    const paires = await this.engine.scanPaires(this.cible, this.filters);

    // Tri (stabilité Firestore : égalité → ordre d'insertion du scan).
    let tries = paires;
    if (this.orders.length > 0) {
      tries = [...paires].sort((a, b) => {
        for (const ordre of this.orders) {
          const c = compareValeurs(champAu(a.data, ordre.field), champAu(b.data, ordre.field));
          if (c !== 0) return ordre.direction === "desc" ? -c : c;
        }
        return 0;
      });
    }

    if (this.limitVal !== undefined) tries = tries.slice(0, this.limitVal);

    const snapshots: FsQueryDocSnapshot[] = tries.map(({ id, collectionPath, data, raw }) => {
      const propre = this.selectFields
        ? (Object.fromEntries(this.selectFields.map((f) => [f, champAu(data, f)])) as Record<string, unknown>)
        : data;
      const ref = new FsDocRef(this.engine, collectionPath, id);
      return new FsQueryDocSnapshot(ref, { exists: true, data: propre, etag: raw.etag, fresh: false });
    });
    return new FsQuerySnapshot(snapshots);
  }

  private clone(): FsQuery<T> {
    const q = new FsQuery<T>(this.engine, this.cible);
    q.filters = this.filters;
    q.orders = this.orders;
    q.limitVal = this.limitVal;
    q.selectFields = this.selectFields;
    return q;
  }
}

export class FsCollection<T = FsDocumentData> extends FsQuery<T> {
  readonly path: string[];

  constructor(
    engine: R2Fs,
    path: string[],
  ) {
    // Une CollectionReference EST une Query (héritage Firestore) : les
    // méthodes where/orderBy/limit/select/get/count/aggregate sont héritées.
    super(engine, { kind: "collection", path });
    this.path = path;
  }

  /** Doc parent quand c'est une sous-collection (organizations/{id}/members). */
  get parent(): FsDocRef | null {
    if (this.path.length < 2) return null;
    // organizations/{id}/members → doc parent = organizations/{id} :
    // chemin = path sans le dernier segment, id = AVANT-dernier segment.
    return new FsDocRef(this.engine, this.path.slice(0, -1), this.path[this.path.length - 2]);
  }

  doc(id?: string): FsDocRef {
    return new FsDocRef(this.engine, this.path, id === undefined ? newDocId() : id);
  }

  /** Création avec identifiant auto (retourne la référence). */
  async add(data: FsDocumentData): Promise<FsDocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

/* ------------------------------------------------------------------ */
/* Moteur — scans, boucles CAS, transactions, batch                    */
/* ------------------------------------------------------------------ */

async function parLot<T, R>(items: T[], taille: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const sortie: R[] = [];
  for (let i = 0; i < items.length; i += taille) {
    sortie.push(...(await Promise.all(items.slice(i, i + taille).map(fn))));
  }
  return sortie;
}

/** Boucle CAS générique : lit, calcule, écrit conditionnellement, retente sur conflit. */
const CAS_MAX_ATTEMPTS = 8;

function delaiRetentative(tentative: number): number {
  return 2 ** tentative + Math.floor(Math.random() * 4);
}

export class R2Fs {
  /** Paires (id, chemin, données) d'une collection OU d'un collectionGroup. */
  async scanPaires(
    cible: Cible,
    filters: FilterSpec[],
  ): Promise<Array<{ id: string; collectionPath: string[]; data: Record<string, unknown>; raw: RawDocSnapshot }>> {
    type CibleScan = { id: string; collectionPath: string[] };
    let ciblesScan: CibleScan[];

    if (cible.kind === "group") {
      const cles = await rawListKeys([], { maxResults: FS_QUERY_SCAN_CAP });
      ciblesScan = cles
        .map((c) => {
          const segments = c.key.replace(/^fs\//, "").replace(/\.json$/, "").split("/");
          return { id: segments[segments.length - 1], collectionPath: segments.slice(0, -1) };
        })
        .filter((m) => m.collectionPath.length >= 1 && m.collectionPath[m.collectionPath.length - 1] === cible.group);
    } else {
      const cles = await rawListKeys(cible.path, { maxResults: FS_QUERY_SCAN_CAP });
      ciblesScan = cles.map((c) => ({ id: c.docId, collectionPath: cible.path }));
    }

    const raws = await parLot(ciblesScan, FS_CONCURRENCY, async (m) => {
      try {
        return await rawGet(m.collectionPath, m.id);
      } catch (error) {
        // Un doc corrompu ne tue pas toute la requête (sémantique listJson).
        if (error instanceof FsError && error.code === "failed_precondition") return null;
        throw error;
      }
    });

    const sortie: Array<{ id: string; collectionPath: string[]; data: Record<string, unknown>; raw: RawDocSnapshot }> = [];
    for (let i = 0; i < raws.length; i += 1) {
      const raw = raws[i];
      if (!raw?.exists || !raw.data) continue;
      const donnees = raw.data;
      if (filters.every((f) => satisfaitFiltre(donnees, f))) {
        sortie.push({ id: ciblesScan[i].id, collectionPath: ciblesScan[i].collectionPath, data: donnees, raw });
      }
    }
    return sortie;
  }

  /** Alias documents bruts pour FsQuery.get (data + metadata). */
  async scanDocs(cible: Cible, filters: FilterSpec[]): Promise<Record<string, unknown>[]> {
    const paires = await this.scanPaires(cible, filters);
    return paires.map((p) => p.data);
  }

  /** set({merge:true}) / update — boucle CAS-réessai (conflits 412). */
  async mergeLoop(
    path: string[],
    id: string,
    patch: FsDocumentData,
    opts?: { requireExisting?: boolean },
  ): Promise<void> {
    for (let tentative = 0; tentative < CAS_MAX_ATTEMPTS; tentative += 1) {
      const lu = await rawGet(path, id);
      if (!lu.exists && opts?.requireExisting) {
        throw new FsError("not_found", `r2fs: No document to update (${[...path, id].join("/")})`);
      }
      const fusion = resoudrePatch(lu.exists ? lu.data : null, patch, Date.now(), "merge");
      try {
        await rawPut(path, id, fusion, lu.exists ? { etag: lu.etag } : { createOnly: true });
        return;
      } catch (error) {
        if (!isConflictError(error) || tentative === CAS_MAX_ATTEMPTS - 1) throw error;
        await new Promise((r) => setTimeout(r, delaiRetentative(tentative)));
      }
    }
  }

  collection(chemin: string): FsCollection {
    const segments = chemin.split("/").filter(Boolean);
    if (segments.length === 0) throw new FsError("invalid_argument", "r2fs: chemin de collection vide.");
    return new FsCollection(this, segments);
  }

  doc(chemin: string): FsDocRef {
    const segments = chemin.split("/").filter(Boolean);
    if (segments.length < 2 || segments.length % 2 !== 0) {
      throw new FsError("invalid_argument", `r2fs: chemin de document invalide (${chemin}) — paires collection/doc requises.`);
    }
    return new FsDocRef(this, segments.slice(0, -1), segments[segments.length - 1]);
  }

  /**
   * TRANSACTION — lecture enregistrée + commit conditionnel (ETag), retry
   * complet sur conflit (sémantique Firestore : le callback est rejoué).
   */
  async runTransaction<T>(fn: (tx: FsTransaction) => Promise<T>, opts?: { maxAttempts?: number }): Promise<T> {
    const maxAttempts = opts?.maxAttempts ?? 5;
    let derniereErreur: unknown;
    for (let tentative = 0; tentative < maxAttempts; tentative += 1) {
      const tx = new FsTransaction(this);
      try {
        const resultat = await fn(tx);
        await tx.commit();
        return resultat;
      } catch (error) {
        if (!isConflictError(error)) throw error; // erreur métier : pas de rejouage
        derniereErreur = error;
        await new Promise((r) => setTimeout(r, delaiRetentative(tentative)));
      }
    }
    throw new FsError("conflict", `r2fs: transaction abandonnée après ${maxAttempts} tentatives (contention).`, { cause: derniereErreur });
  }

  async recursiveDelete(ref: FsDocRef | FsCollection): Promise<number> {
    const prefix = ref instanceof FsCollection
      ? collectionPrefix(ref.path)
      : `${docKey(ref.collectionPath, ref.id).replace(/\.json$/, "")}/`;
    let supprimes = 0;
    // Boucle de purge (cap par passe) : >2000 descendants → passes suivantes.
    for (;;) {
      const cles = await rawListKeys([], { maxResults: 2000 });
      const cibles = cles
        .map((c) => ({ key: c.key, segments: parseKey(c.key) }))
        .filter((c): c is { key: string; segments: string[] } => c.segments !== null && c.key.startsWith(prefix));
      if (cibles.length === 0) break;
      await parLot(cibles, 10, async (c) => {
        const chemin = c.segments.slice(0, -1);
        await rawDelete(chemin, c.segments[c.segments.length - 1]);
      });
      supprimes += cibles.length;
      if (cibles.length < 2000) break;
    }
    if (ref instanceof FsDocRef) {
      await rawDelete(ref.collectionPath, ref.id);
      supprimes += 1;
    }
    return supprimes;
  }

  batch(): FsWriteBatch {
    return new FsWriteBatch(this);
  }

  /**
   * collectionGroup — requête transversale sur TOUTES les collections portant
   * ce nom (racine et imbriquées). Un seul usage dans le projet (invitations
   * d'organisations). Plafond de scan : FS_QUERY_SCAN_CAP objets sous fs/.
   */
  collectionGroup(nom: string): FsQuery {
    if (!nom || nom.includes("/")) {
      throw new FsError("invalid_argument", `r2fs: nom de collectionGroup invalide (${nom}).`);
    }
    return new FsQuery(this, { kind: "group", path: [], group: nom });
  }
}

/** Filtre Firestore-like sur doc hydraté. */
function satisfaitFiltre(data: Record<string, unknown>, filtre: FilterSpec): boolean {
  const valeur = champAu(data, filtre.field);
  const cible = comparable(filtre.valeur);
  const v = comparable(valeur);
  switch (filtre.op) {
    case "==":
      return compareValeurs(v, cible) === 0;
    case "!=":
      return compareValeurs(v, cible) !== 0;
    case ">":
      return compareValeurs(v, cible) > 0;
    case ">=":
      return compareValeurs(v, cible) >= 0;
    case "<":
      return compareValeurs(v, cible) < 0;
    case "<=":
      return compareValeurs(v, cible) <= 0;
    case "in":
      return Array.isArray(cible) && cible.some((item) => compareValeurs(v, comparable(item)) === 0);
    case "array-contains":
      return Array.isArray(v) && v.some((item) => compareValeurs(item, cible) === 0);
    default:
      throw new FsError("invalid_argument", `r2fs: opérateur where non supporté (${String(filtre.op)}).`);
  }
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

type TxOp =
  | { kind: "set"; ref: FsDocRef; data: FsDocumentData; merge: boolean }
  | { kind: "create"; ref: FsDocRef; data: FsDocumentData }
  | { kind: "update"; ref: FsDocRef; data: FsDocumentData }
  | { kind: "delete"; ref: FsDocRef };

export class FsTransaction {
  private lectures = new Map<string, RawDocSnapshot>();
  private ops: TxOp[] = [];

  constructor(private readonly engine: R2Fs) {}

  private cleDe(ref: FsDocRef): string {
    return `${ref.collectionPath.join("/")}/${ref.id}`;
  }

  async get(ref: FsDocRef): Promise<FsDocSnapshot>;
  /** Les transactions Firestore acceptent aussi les LECTURES DE REQUÊTE —
   *  scan exécuté immédiatement (les écritures CAS restent sur les docs lus). */
  async get(query: FsQuery): Promise<FsQuerySnapshot>;
  async get(refOuQuery: FsDocRef | FsQuery): Promise<FsDocSnapshot | FsQuerySnapshot> {
    if (refOuQuery instanceof FsQuery) {
      return refOuQuery.get();
    }
    const ref = refOuQuery;
    const cle = this.cleDe(ref);
    let raw = this.lectures.get(cle);
    if (!raw) {
      raw = await rawGet(ref.collectionPath, ref.id);
      this.lectures.set(cle, raw);
    }
    return new FsDocSnapshot(ref, raw);
  }

  set(ref: FsDocRef, data: FsDocumentData, opts?: { merge?: boolean }): FsTransaction {
    this.ops.push({ kind: "set", ref, data, merge: Boolean(opts?.merge) });
    return this;
  }

  update(ref: FsDocRef, data: FsDocumentData): FsTransaction {
    this.ops.push({ kind: "update", ref, data });
    return this;
  }

  /** Création stricte en transaction (doc absent requis, garanti au commit). */
  create(ref: FsDocRef, data: FsDocumentData): FsTransaction {
    this.ops.push({ kind: "create", ref, data });
    return this;
  }

  delete(ref: FsDocRef): FsTransaction {
    this.ops.push({ kind: "delete", ref });
    return this;
  }

  /** Commit conditionnel : chaque écriture valide l'ETag lu (ou crée atomiquement). */
  async commit(): Promise<void> {
    // update/delete sur doc LU ABSENT → échec (comme Firestore). Jamais lus →
    // résolus au commit contre l'état RÉEL (lecture serveur Firestore).
    for (const op of this.ops) {
      if (op.kind === "set" || op.kind === "create") continue;
      const lu = this.lectures.get(this.cleDe(op.ref));
      if (lu && !lu.exists) {
        throw new FsError("not_found", `r2fs: No document to ${op.kind} in transaction (${op.ref.path})`);
      }
    }
    for (const op of this.ops) {
      const lu = this.lectures.get(this.cleDe(op.ref));
      switch (op.kind) {
        case "create": {
          if (lu && lu.exists) {
            throw new FsError("already_exists", `r2fs: create sur un document déjà existant en transaction (${op.ref.path})`);
          }
          const ecrase = resoudrePatch(null, op.data, Date.now(), "set");
          // Lu absent ou jamais lu → création conditionnelle atomique. Un
          // conflit (créé concurremment) = déjà-existant, PAS un retry.
          try {
            await rawPut(op.ref.collectionPath, op.ref.id, ecrase, { createOnly: true });
          } catch (error) {
            if (isConflictError(error)) {
              throw new FsError("already_exists", `r2fs: document créé concurremment (${op.ref.path})`);
            }
            throw error;
          }
          break;
        }
        case "set": {
          if (lu && lu.exists) {
            if (op.merge) {
              const fusion = resoudrePatch(lu.data, op.data, Date.now(), "merge");
              await rawPut(op.ref.collectionPath, op.ref.id, fusion, { etag: lu.etag });
            } else {
              const ecrase = resoudrePatch(null, op.data, Date.now(), "set");
              await rawPut(op.ref.collectionPath, op.ref.id, ecrase, { etag: lu.etag });
            }
          } else if (op.merge) {
            // Doc non lu (ou absent au moment de la lecture) : merge contre
            // l'état RÉEL, boucle CAS réessayable (création atomique si absent).
            await this.engine.mergeLoop(op.ref.collectionPath, op.ref.id, op.data, { requireExisting: false });
          } else {
            const ecrase = resoudrePatch(null, op.data, Date.now(), "set");
            // Lu absent → création conditionnelle (évite d'écraser un
            // créateur concurrent) ; jamais lu → écriture assumée.
            await rawPut(op.ref.collectionPath, op.ref.id, ecrase, lu ? { createOnly: true } : undefined);
          }
          break;
        }
        case "update": {
          if (lu && lu.exists) {
            const fusion = resoudrePatch(lu.data, op.data, Date.now(), "merge");
            await rawPut(op.ref.collectionPath, op.ref.id, fusion, { etag: lu.etag });
          } else {
            // Jamais lu en tx : résolu contre l'état réel (comme Firestore,
            // qui lit le doc côté serveur au commit). Échec si absent.
            await this.engine.mergeLoop(op.ref.collectionPath, op.ref.id, op.data, { requireExisting: true });
          }
          break;
        }
        case "delete": {
          if (lu && lu.exists) {
            await rawDelete(op.ref.collectionPath, op.ref.id, { etag: lu.etag });
          } else {
            // Jamais lu en tx : lecture fraîche + CAS. Absent → no-op
            // (delete Firestore sur doc manquant ne lève pas).
            const frais = await rawGet(op.ref.collectionPath, op.ref.id);
            if (frais.exists) {
              await rawDelete(op.ref.collectionPath, op.ref.id, { etag: frais.etag });
            }
          }
          break;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Batch                                                               */
/* ------------------------------------------------------------------ */

export class FsWriteBatch {
  private ops: TxOp[] = [];

  constructor(private readonly engine: R2Fs) {}

  set(ref: FsDocRef, data: FsDocumentData, opts?: { merge?: boolean }): FsWriteBatch {
    this.ops.push({ kind: "set", ref, data, merge: Boolean(opts?.merge) });
    return this;
  }

  update(ref: FsDocRef, data: FsDocumentData): FsWriteBatch {
    this.ops.push({ kind: "update", ref, data });
    return this;
  }

  /** Création stricte en batch (doc absent requis). */
  create(ref: FsDocRef, data: FsDocumentData): FsWriteBatch {
    this.ops.push({ kind: "create", ref, data });
    return this;
  }

  delete(ref: FsDocRef): FsWriteBatch {
    this.ops.push({ kind: "delete", ref });
    return this;
  }

  /**
   * Commit séquentiel : update/delete en CAS-boucle (état réel), set
   * écrasant inconditionnel (last-write-wins). Atomicité PAR DOCUMENT —
   * les usages du projet (purges, marquages de masse) l'acceptent.
   */
  async commit(): Promise<void> {
    for (const op of this.ops) {
      switch (op.kind) {
        case "create": {
          const resolu = resoudrePatch(null, op.data, Date.now(), "set");
          try {
            await rawPut(op.ref.collectionPath, op.ref.id, resolu, { createOnly: true });
          } catch (error) {
            if (isConflictError(error)) {
              throw new FsError("already_exists", `r2fs: batch create sur un document déjà existant (${op.ref.path})`);
            }
            throw error;
          }
          break;
        }
        case "set":
          if (op.merge) {
            await this.engine.mergeLoop(op.ref.collectionPath, op.ref.id, op.data, { requireExisting: false });
          } else {
            await rawPut(op.ref.collectionPath, op.ref.id, resoudrePatch(null, op.data, Date.now(), "set"));
          }
          break;
        case "update":
          await this.engine.mergeLoop(op.ref.collectionPath, op.ref.id, op.data, { requireExisting: true });
          break;
        case "delete":
          await rawDelete(op.ref.collectionPath, op.ref.id);
          break;
      }
    }
  }
}
