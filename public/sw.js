/*
 * Service worker Gen3ia — support PWA + EXÉCUTION EN ARRIÈRE-PLAN
 * (demande utilisateur : « fonctionner en arrière-plan de l'appareil
 * connecté pour qu'il puisse fonctionner même hors ligne lorsqu'une tâche
 * est prise en charge »).
 *
 * Stratégie volontairement conservative (le SW historique servait une page
 * hors-ligne à la place du Studio — bug corrigé ; NE PAS recacher les
 * navigations) :
 * - Navigation            : TOUJOURS le réseau (aucun fallback HTML).
 * - Statiques _next/static: jamais mises en cache (fichiers versionnés par build).
 * - /api/                 : jamais mises en cache (données personnelles).
 * - POST de chat/mission  : si l'appareil est HORS LIGNE, la requête est
 *   placée dans une file durable (IndexedDB) puis REJOUÉE AUTOMATIQUEMENT
 *   par Background Sync dès le retour du réseau — la tâche prise en charge
 *   part quand même. La page est prévenue par postMessage.
 */
const DB_NAME = "gen3ia-outbox";
const STORE = "requests";
const SYNC_TAG = "gen3ia-outbox";
const QUEUED_PATHS = ["/api/chat/message", "/api/agent/chat", "/api/workspace/tasks"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.sync?.register?.(SYNC_TAG).catch(() => undefined);
      await self.clients.matchAll({ type: "window" });
    })(),
  );
});

/* --------------------------- File hors-ligne --------------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function enqueue(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function listQueued() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

async function deleteQueued(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function notifyClients(payload) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage(payload);
}

/* ------------------------- Interception réseau ------------------------- */

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "POST") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!QUEUED_PATHS.some((path) => url.pathname.startsWith(path))) return;

  event.respondWith(
    (async () => {
      try {
        // En ligne : laisser passer la requête réelle.
        return await fetch(request);
      } catch (error) {
        // Hors ligne : mise en file durable + reprise automatique.
        const body = await request.clone().text().catch(() => "");
        await enqueue({
          url: url.toString(),
          method: "POST",
          headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
          body,
          queuedAtMs: Date.now(),
          attempts: 0,
        });
        await self.registration.sync?.register?.(SYNC_TAG).catch(() => undefined);
        return new Response(JSON.stringify({ queued: true, offline: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
    })(),
  );
});

/* ------------------------ Reprise (Background Sync) ------------------- */

async function flushOutbox() {
  const items = await listQueued();
  for (const item of items) {
    try {
      const response = await fetch(item.url, {
        method: "POST",
        headers: item.headers ?? { "content-type": "application/json" },
        body: item.body,
        credentials: "include",
      });
      if (response.ok || response.status === 401 || response.status === 400) {
        // 401/400 : non rejouable à l'infini (session expirée / payload invalide).
        await deleteQueued(item.id);
        await notifyClients({ type: "gen3ia-outbox-flushed", url: item.url, status: response.status });
      } else if (response.status >= 500) {
        throw new Error("retryable");
      } else {
        await deleteQueued(item.id);
      }
    } catch {
      // Toujours hors ligne : nouvelle tentative au prochain sync.
      await notifyClients({ type: "gen3ia-outbox-pending", url: item.url });
      break;
    }
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushOutbox());
});

// Reprise également au démarrage du SW (navigateurs sans Background Sync).
self.addEventListener("message", (event) => {
  if (event.data === "gen3ia-flush") event.waitUntil(flushOutbox());
});
