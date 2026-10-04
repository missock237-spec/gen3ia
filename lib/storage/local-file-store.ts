"use client";

const DB_NAME = "gen3ia-local-files";
const STORE_NAME = "files";
const DB_VERSION = 1;

export interface LocalFileRecord {
  id: string;
  projectId?: string;
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
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
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
