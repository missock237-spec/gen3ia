/*
 * Service worker Gen3ia AI Studio — support application installable
 * (Android / iOS / desktop PWA) et page hors-ligne.
 *
 * Strategie volontairement conservative :
 * - Navigation            : reseau d'abord, repli offline.html si indisponible.
 * - Statiques _next/static: cache premier (fichiers versionnes par build).
 * - /api/                 : jamais mises en cache (donnees personnelles, temps reel).
 * - Firebase Auth/FCM     : laisses tels quels (hors scope meme origine).
 */
// Le service worker historique pouvait servir une page hors-ligne à la place
// du Studio après une erreur réseau passagère. Il se désinstalle explicitement
// afin de rendre le contrôle des navigations au navigateur et à Next.js.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((client) => client.navigate(client.url))),
  );
});
