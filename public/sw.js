/*
 * Service worker Gen3ia — support PWA + file hors-ligne fiable.
 *
 * Stratégie volontairement conservative (le SW historique servait une page
 * hors-ligne à la place du Studio — bug corrigé) :
 * - Navigation            : réseau D'ABORD ; offline.html UNIQUEMENT si le
 *   réseau est indisponible (plus jamais l'inverse — bug historique).
 * - Statiques immuables   : /_next/static/* (versionnées par build) et
 *   /icons/* servies en cache-first avec borne (purge au-delà de 100 entrées)
 *   — revisites et hors-ligne instantanés ; GET same-origin uniquement,
 *   navigations et /api/ inchangés.
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
// Cache des statiques IMMUBABLES (lot C4) : /_next/static/* est versionnée
// par build (contenu immuable), /icons/* est quasi immuable — cache-first
// borné (purge des plus anciennes entrées au-delà du plafond).
const IMMUTABLE_CACHE = "gen3ia-immutable-v1";
const IMMUTABLE_PREFIXES = ["/_next/static/", "/icons/"];
const IMMUTABLE_MAX_ENTRIES = 100;
// Liste blanche des caches conservés entre les versions : le fallback
// hors-ligne et les statiques immuables. Tout autre cache « gen3ia-* »
// hérité d'un ancien service worker est purgé à l'activation (les caches
// orphelins s'accumulaient à chaque déploiement jusqu'à saturation du quota).
const KEPT_CACHES = new Set(["gen3ia-offline-v1", "gen3ia-immutable-v1"]);

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
      // Purge des caches hérités : les anciens service workers laissaient des
      // caches « gen3ia-* » orphelins qui s'accumulaient à chaque déploiement
      // — tout cache hors liste blanche est supprimé ici.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("gen3ia-") && !KEPT_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      // Prise de contrôle IMMÉDIATE : les pages déjà ouvertes passent sous le
      // nouveau SW sans attendre un rechargement manuel (déclenche
      // « controllerchange » côté client, exploité par pwa-register pour
      // appliquer la nouvelle version au moment sûr).
      await self.clients.claim();
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

/* ------------------- Cache des statiques immuables --------------------- */

// Cache-first pour /_next/static/* (URLs versionnées, immuables) et /icons/*.
// Mise en cache : uniquement les réponses OK ; aucune revalidation — le
// contenu versionné ne change jamais, une nouvelle version = une nouvelle URL.
async function cacheFirstImmutable(request) {
  const cache = await caches.open(IMMUTABLE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) await putBounded(cache, request, response.clone());
    return response;
  } catch {
    // Hors ligne et absente du cache : erreur réseau (jamais offline.html,
    // réservé aux navigations).
    return Response.error();
  }
}

// Borne simple : les clés du Cache sont itérées en ordre d'insertion —
// au-delà du plafond, les plus anciennes entrées sont purgées. Une entrée
// chassée (URL immuable) se re-télécharge une seule fois si ré-demandée.
async function putBounded(cache, request, response) {
  await cache.put(request, response);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - IMMUTABLE_MAX_ENTRIES; i++) {
    await cache.delete(keys[i]);
  }
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

  // Statiques immuables (lot C4) : cache-first borné. GET same-origin sans
  // plage uniquement — navigations, POST et /api/ restent inchangés.
  if (
    request.method === "GET" &&
    !request.headers.has("range") &&
    IMMUTABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  ) {
    event.respondWith(cacheFirstImmutable(request));
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
          // Compteur FIDÈLE : l'item vient d'être enfilé — la longueur réelle
          // de la file permet au banner d'afficher un badge exact.
          await notifyClients({
            type: "gen3ia-outbox-pending",
            url: url.pathname,
            pendingCount: (await listQueued()).length,
          });
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
            // L'item reste en file : on transmet la longueur réelle restante.
            await notifyClients({
              type: "gen3ia-outbox-pending",
              url: item.url,
              attempts,
              pendingCount: (await listQueued()).length,
            });
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
        // Toujours hors ligne : nouvelle tentative au prochain sync (l'item
        // reste en file — on transmet la longueur réelle restante).
        await notifyClients({
          type: "gen3ia-outbox-pending",
          url: item.url,
          pendingCount: (await listQueued()).length,
        });
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

/* --------------------- Notifications natives (clic) -------------------- */

// Clic sur une notification native montrée par le SW (Android + app
// installée) : retour dans l'app, sur le chemin associé — fenêtre
// existante réutilisée, sinon ouverte.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? "/dashboard";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(targetUrl).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});

// Reprise également au démarrage du SW (navigateurs sans Background Sync).
self.addEventListener("message", (event) => {
  // Seuls les documents de NOTRE origine pilotent le SW (alerte CodeQL
  // missing-origin-check : un postMessage intersites ne doit jamais
  // déclencher la reprise de la file d'envoi).
  if (event.origin !== self.location.origin) return;
  if (event.data === "gen3ia-flush") event.waitUntil(flushOutbox());
});
