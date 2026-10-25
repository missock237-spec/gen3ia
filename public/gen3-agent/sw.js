/*
 * AGENT GEN3 — le petit agent qui se télécharge dans le cache du navigateur.
 *
 * Service Worker dédié (portée /gen3-agent/), installé AUTOMATIQUEMENT à
 * l'inscription ou à la connexion de l'utilisateur. Son rôle honnête :
 *  1. PRÉSENCE PERMANENTE : il vit dans le cache du navigateur même après
 *     fermeture des onglets (jusqu'à l'arrêt du worker par le navigateur) ;
 *  2. COFFRE LOCAL : il pré-cache les ressources de l'essaim (manifeste des
 *     modèles, noyau onnxruntime) et met au chaud progressivement les poids
 *     média demandés par la page — la génération suivante démarre à chaud ;
 *  3. RELAIS DE VEILLE : il stocke la dernière onde reçue (affectations,
 *     livraisons) et la rejoue à la page à son retour — aucune part de
 *     tâche n'est perdue pendant une navigation.
 *
 * Ce que l'agent ne fait PAS (honnêteté) : le calcul WebGPU lourd s'exécute
 * dans la page (l'API GPU n'est pas exposée aux Service Workers en 2026) ;
 * l'agent reste le coffre-fort et la vigie de l'essaim.
 */

const CACHE_AGENT = "gen3-agent-v1";
const VERSION = "1.0.0";

/** Ressources de base de l'agent (minuscules — les poids arrivent ensuite). */
const BASE_PRÉ_CACHE = [
  "/gen3-agent/sw.js",
  "https://huggingface.co/Kings237/gen3ia-media-engine/resolve/main/MANIFEST.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_AGENT);
      await Promise.allSettled(BASE_PRÉ_CACHE.map((u) => cache.add(u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const clés = await caches.keys();
      await Promise.all(
        clés.filter((k) => k.startsWith("gen3-agent-") && k !== CACHE_AGENT).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Cache-first sur la portée de l'agent, transparence partout ailleurs. */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const dansLaPortée =
    url.origin === self.location.origin && url.pathname.startsWith("/gen3-agent/");
  const poidsMédia = url.hostname.endsWith("huggingface.co");
  if (!dansLaPortée && !poidsMédia) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_AGENT);
      const enCache = await cache.match(event.request);
      // Stale-while-revalidate : l'onde part du cache, se rafraîchit en fond.
      const réseau = fetch(event.request)
        .then((réponse) => {
          if (réponse && réponse.ok) {
            const copie = réponse.clone();
            void cache.put(event.request, copie);
          }
          return réponse;
        })
        .catch(() => undefined);
      return enCache || (await réseau) || Response.error();
    })(),
  );
});

/** API de messages page ↔ agent. */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  const répondre = (payload) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  };

  if (data.type === "gen3-agent:ping") {
    répondre({ type: "gen3-agent:etat", version: VERSION, cache: CACHE_AGENT });
    return;
  }

  if (data.type === "gen3-agent:précache") {
    // La page demande de mettre au chaud des poids (URLs du manifeste).
    // Progression rapportée URL par URL (précache_prog) puis bilan (précache_ok).
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_AGENT);
        const urls = Array.isArray(data.urls) ? data.urls.slice(0, 12) : [];
        let ok = 0;
        await Promise.allSettled(
          urls.map(async (u, i) => {
            let réussi = false;
            try {
              await cache.add(u);
              réussi = true;
              ok += 1;
            } catch {
              /* poids volumineux : cache progressif, pas d'échec fatal */
            }
            try {
              répondre({ type: "gen3-agent:précache_prog", i, total: urls.length, ok: réussi });
            } catch {
              /* le canal de réponse peut être fermé (onglet parti) */
            }
          }),
        );
        répondre({ type: "gen3-agent:précache_ok", n: ok });
      })(),
    );
    return;
  }

  if (data.type === "gen3-agent:onde") {
    // Dernière onde reçue par la page : stockée pour la veille.
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_AGENT);
        await cache.put(
          "/gen3-agent/derniere-onde",
          new Response(JSON.stringify({ onde: data.onde ?? null, ts: Date.now() }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
        répondre({ type: "gen3-agent:onde_stockee" });
      })(),
    );
  }
});
