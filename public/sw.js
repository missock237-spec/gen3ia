/*
 * Service worker Gen3ia — support PWA + file hors-ligne fiable.
 *
 * Stratégie volontairement conservative (le SW historique servait une page
 * hors-ligne à la place du Studio — bug corrigé) :
 * - Navigation            : réseau D'ABORD ; offline.html UNIQUEMENT si le
 *   réseau est indisponible (plus jamais l'inverse — bug historique).
 * - Statiques _next/static: jamais mises en cache (fichiers versionnés par build).
 * - /api/                 : jamais mises en cache (données personnelles).
 * - POST de mission agent : si l'appareil est HORS LIGNE, la requête est
 *   placée dans une file durable (IndexedDB) puis REJOUÉE AUTOMATIQUEMENT
 *   par Background Sync dès le retour du réseau — avec clé d'idempotence
 *   (x-gen3ia-idempotency-key) pour qu'un replay ne double JAMAIS une
 *   mission ni une facturation. Chaque issue (délivré / échec définitif /
 *   en attente) est notifiée aux pages : jamais de perte silencieuse.
 */
const DB_NAME = "gen3ia-outbox";
const STORE = "requests";
const SYNC_TAG = "gen3ia-outbox";
const OFFLINE_URL = "/offline.html";
// File STRICTE : la route de chat d'agent EXACTE (jamais /approve ni
// /continue — ces décisions ne partent jamais en file) et la création de
// tâche workspace. /api/chat/message est morte dans l'app et est retirée.
const QUEUED_PATHS = new Set(["/api/agent/chat", "/api/workspace/tasks"]);
const MAX_ATTEMPTS = 5;

self.addEventListener("install", (event) => {
  // Fallback hors-ligne UNIQUEMENT pour les navigations (network-first :
  // jamais servi quand le réseau répond — bug historique corrigé).
  event.waitUntil(
    (async () => {
      const cache = await caches.open("gen3ia-offline-v1");
      await cache.add(OFFLINE_URL).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});
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

async function updateQueued(id, patch) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const get = store.get(id);
    get.onsuccess = () => {
      if (get.result) store.put({ ...get.result, ...patch });
    };
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
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations : réseau d'abord, offline.html en DERNIER recours.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open("gen3ia-offline-v1");
          const offline = await cache.match(OFFLINE_URL);
          return offline ?? Response.error();
        }
      })(),
    );
    return;
  }

  // File hors-ligne STRICTE pour les POST de mission : correspondance
  // exacte du pathname (le préfixe large historique capturait aussi
  // /api/agent/chat/approve et /continue — des décisions à ne jamais
  // mettre en file).
  if (request.method !== "POST") return;
  if (!QUEUED_PATHS.has(url.pathname)) return;

  event.respondWith(
    (async () => {
      try {
        // En ligne : laisser passer la requête réelle.
        return await fetch(request);
      } catch {
        // Hors ligne : mise en file durable + reprise automatique.
        try {
          const body = await request.clone().text().catch(() => "");
          const idempotencyKey = (self.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, "");
          await enqueue({
            url: url.toString(),
            method: "POST",
            headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
            body,
            queuedAtMs: Date.now(),
            attempts: 0,
            idempotencyKey,
          });
          await self.registration.sync?.register?.(SYNC_TAG).catch(() => undefined);
          await notifyClients({ type: "gen3ia-outbox-pending", url: url.pathname });
          return new Response(JSON.stringify({ queued: true, offline: true }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        } catch {
          // IndexedDB indisponible (quota, navigation privée) : réponse
          // claire plutôt qu'une erreur réseau brute côté page.
          return new Response(JSON.stringify({ error: "File hors-ligne indisponible sur cet appareil. Reconnectez-vous au réseau pour envoyer ce message.", code: "OFFLINE_UNAVAILABLE" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
      }
    })(),
  );
});

/* ------------------------ Reprise (Background Sync) ------------------- */

// Verrou anti-concurrence : sync event + gen3ia-flush (chargement de page,
// retour du réseau) pouvaient rejouer le MÊME item en parallèle → mission
// doublée (et facturée deux fois). Un seul flush à la fois.
let flushing = false;

async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const items = await listQueued();
    for (const item of items) {
      try {
        const response = await fetch(item.url, {
          method: "POST",
          headers: {
            ...(item.headers ?? { "content-type": "application/json" }),
            // Idempotence : le serveur peut reconnaître un replay et ne
            // jamais doubler une mission ni une facturation.
            ...(item.idempotencyKey ? { "x-gen3ia-idempotency-key": item.idempotencyKey } : {}),
          },
          body: item.body,
          credentials: "include",
        });
        if (response.ok) {
          await deleteQueued(item.id);
          await notifyClients({ type: "gen3ia-outbox-flushed", url: item.url, status: response.status });
        } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
          // Transitoire : on retente plus tard (plafonné).
          const attempts = Number(item.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await deleteQueued(item.id);
            await notifyClients({ type: "gen3ia-outbox-failed", url: item.url, status: response.status, reason: "max_attempts" });
          } else {
            await updateQueued(item.id, { attempts });
            await notifyClients({ type: "gen3ia-outbox-pending", url: item.url, attempts });
            break;
          }
        } else {
          // 4xx définitif (401 session expirée, 400 payload, 403, 409…) :
          // retiré de la file MAIS signalé à l'utilisateur — jamais de
          // perte silencieuse.
          await deleteQueued(item.id);
          await notifyClients({ type: "gen3ia-outbox-failed", url: item.url, status: response.status, reason: "rejected" });
        }
      } catch {
        // Toujours hors ligne : nouvelle tentative au prochain sync.
        await notifyClients({ type: "gen3ia-outbox-pending", url: item.url });
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushOutbox());
});

// Reprise également au démarrage du SW (navigateurs sans Background Sync).
self.addEventListener("message", (event) => {
  if (event.data === "gen3ia-flush") event.waitUntil(flushOutbox());
});
