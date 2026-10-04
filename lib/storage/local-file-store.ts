"use client";

const DB_NAME = "gen3ia-local-files";
const STORE_NAME = "files";
const DB_VERSION = 2;
const PROJECT_STORE_NAME = "projects";
const SYNC_STORE_NAME = "syncQueue";

export interface LocalFileRecord {
  id: string;
  projectId?: string;
  serverAssetId?: string;
  name: string;
  type: string;
  size: number;
  updatedAt: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PROJECT_STORE_NAME)) db.createObjectStore(PROJECT_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SYNC_STORE_NAME)) db.createObjectStore(SYNC_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveLocalFile(file: File, id = crypto.randomUUID(), projectId?: string): Promise<LocalFileRecord> {
  const record: LocalFileRecord = {
    id,
    projectId,
    name: file.name,
    type: file.type,
    size: file.size,
    updatedAt: Date.now(),
    blob: file,
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return record;
}

export async function getLocalFile(id: string): Promise<LocalFileRecord | null> {
  const db = await openDb();
  const record = await new Promise<LocalFileRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as LocalFileRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return record;
}

export async function deleteLocalFile(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}


export async function listLocalFiles(projectId?: string): Promise<LocalFileRecord[]> {
  const db = await openDb();
  const records = await new Promise<LocalFileRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const all = (request.result as LocalFileRecord[]) ?? [];
      resolve(projectId ? all.filter((file) => file.projectId === projectId) : all);
    };
    request.onerror = () => reject(request.error);
  });
  db.close();
  return records;
}

export async function createLocalObjectUrl(id: string): Promise<string | null> {
  const record = await getLocalFile(id);
  return record ? URL.createObjectURL(record.blob) : null;
}


export async function updateLocalFile(
  id: string,
  patch: Partial<Pick<LocalFileRecord, "projectId" | "serverAssetId" | "name">>,
): Promise<void> {
  const record = await getLocalFile(id);
  if (!record) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ ...record, ...patch, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}


export async function cacheLocalProject<T extends { id: string }>(project: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE_NAME, "readwrite");
    tx.objectStore(PROJECT_STORE_NAME).put({ id: project.id, project, cachedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getCachedLocalProject<T extends { id: string }>(id: string): Promise<{ project: T; cachedAt: number } | null> {
  const db = await openDb();
  const value = await new Promise<{ project: T; cachedAt: number } | null>((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE_NAME, "readonly");
    const request = tx.objectStore(PROJECT_STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as { project: T; cachedAt: number } | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}


export type LocalSyncStatus = "pending" | "syncing" | "synced" | "error";

export interface LocalSyncItem {
  id: string;
  projectId: string;
  localFileId: string;
  status: LocalSyncStatus;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export async function enqueueLocalSync(projectId: string, localFileId: string): Promise<LocalSyncItem> {
  const db = await openDb();
  const item: LocalSyncItem = {
    id: `file:${localFileId}`,
    projectId,
    localFileId,
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE_NAME, "readwrite");
    tx.objectStore(SYNC_STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return item;
}

export async function listLocalSyncItems(status?: LocalSyncStatus): Promise<LocalSyncItem[]> {
  const db = await openDb();
  const items = await new Promise<LocalSyncItem[]>((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE_NAME, "readonly");
    const request = tx.objectStore(SYNC_STORE_NAME).getAll();
    request.onsuccess = () => {
      const all = (request.result as LocalSyncItem[]) ?? [];
      resolve(status ? all.filter((item) => item.status === status) : all);
    };
    request.onerror = () => reject(request.error);
  });
  db.close();
  return items;
}

export async function updateLocalSyncItem(id: string, patch: Partial<Pick<LocalSyncItem, "status" | "attempts" | "lastError">>): Promise<void> {
  const db = await openDb();
  const current = await new Promise<LocalSyncItem | null>((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE_NAME, "readonly");
    const request = tx.objectStore(SYNC_STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as LocalSyncItem | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!current) { db.close(); return; }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE_NAME, "readwrite");
    tx.objectStore(SYNC_STORE_NAME).put({ ...current, ...patch, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
