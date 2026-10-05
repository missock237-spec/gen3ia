import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 5 du plan 20 — version app (PWA) fonctionnelle, sans blocage, en
 * synchro avec le web. Garde-fous structurels du service worker et de la
 * chaîne hors-ligne.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Service worker — file hors-ligne fiable", () => {
  const sw = read("public/sw.js");

  it("la file est STRICTE : /api/chat/message retirée, /approve et /continue jamais capturés", () => {
    expect(sw).not.toContain('"/api/chat/message"');
    expect(sw).toContain('new Set(["/api/agent/chat", "/api/workspace/tasks"])');
    // Correspondance EXACTE du pathname (le startsWith historique capturait
    // /api/agent/chat/approve et /continue — des décisions à ne jamais filer).
    expect(sw).toContain("QUEUED_PATHS.has(url.pathname)");
    expect(sw).not.toContain("QUEUED_PATHS.some((path) => url.pathname.startsWith(path))");
  });

  it("verrou anti-concurrence : un seul flush à la fois (missions jamais doublées)", () => {
    expect(sw).toContain("let flushing = false");
    expect(sw).toContain("if (flushing) return");
    expect(sw).toContain("flushing = true");
    expect(sw).toContain("flushing = false");
  });

  it("idempotence : chaque item porte une clé et le replay l'envoie au serveur", () => {
    expect(sw).toContain("idempotencyKey");
    expect(sw).toContain('"x-gen3ia-idempotency-key"');
  });

  it("les navigations tombent sur offline.html UNIQUEMENT en cas d'échec réseau (network-first)", () => {
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw).toContain("/offline.html");
    // Réseau d'abord : jamais l'inverse (bug historique).
    expect(sw.indexOf("return await fetch(request)")).toBeGreaterThan(-1);
  });

  it("IndexedDB indisponible → 503 explicite (jamais une erreur réseau brute)", () => {
    expect(sw).toContain("OFFLINE_UNAVAILABLE");
  });

  it("aucune perte silencieuse : les échecs définitifs sont notifiés (outbox-failed)", () => {
    expect(sw).toContain('"gen3ia-outbox-failed"');
    expect(sw).toContain('reason: "max_attempts"');
    expect(sw).toContain('reason: "rejected"');
  });

  it("les erreurs transitoires sont replafonnées (MAX_ATTEMPTS), pas rejouées à l'infini", () => {
    expect(sw).toContain("MAX_ATTEMPTS = 5");
    expect(sw).toContain("updateQueued");
  });
});

describe("Manifest & UI — app installable cohérente", () => {
  it("manifest : theme_color/background_color alignés sur le thème sombre de boot", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest")) as { theme_color: string; background_color: string };
    expect(manifest.theme_color.toLowerCase()).toBe("#05060c");
    expect(manifest.background_color.toLowerCase()).toBe("#0b0d1a");
  });

  it("mission-composer : le bouton n'est plus jamais bloqué (finally) et le 202 queued est annoncé honnêtement", () => {
    const composer = read("components/workspace/mission-composer.tsx");
    expect(composer).toContain("} finally {");
    expect(composer).toContain("setBusy(false)");
    expect(composer).toContain("data.queued && data.offline");
    expect(composer).toContain("au retour du réseau");
  });

  it("agent-chat-panel : 202 queued annoncé honnêtement, décisions jamais mises en file, panneau anti-crash", () => {
    const panel = read("components/agent/agent-chat-panel.tsx");
    expect(panel).toContain("data.queued && data.offline");
    expect(panel).toContain("plan?.steps?.map");
    expect(panel).toContain('"gen3ia:outbox-failed"');
  });

  it("pwa-register : flush via serviceWorker.ready + relais des échecs et files pendantes", () => {
    const register = read("components/pwa-register.tsx");
    expect(register).toContain("navigator.serviceWorker.ready");
    expect(register).toContain('"gen3ia:outbox-failed"');
    expect(register).toContain('"gen3ia:outbox-pending"');
  });
});

describe("Mises à jour multi-appareils — le nouveau build atteint les pages ouvertes", () => {
  it("le SW prend le contrôle immédiatement (skipWaiting) à l'installation", () => {
    const sw = read("public/sw.js");
    expect(sw).toContain("skipWaiting");
  });

  it("pwa-register : applique la nouvelle version au moment sûr (reload gardé, signal sinon)", () => {
    const register = read("components/pwa-register.tsx");
    // Détection d'un SW prêt à prendre le contrôle (update disponible).
    expect(register).toContain("reg.waiting");
    // Reprise de contrôle par un SW plus récent → application (garde anti-boucle session).
    expect(register).toContain("controllerchange");
    expect(register).toContain("pageWasControlled");
    expect(register).toContain("gen3ia-sw-reloaded");
    // Onglet caché = moment sûr ; onglet visible = signal doux (jamais de coupure d'une mission).
    expect(register).toContain("visibilityState");
    expect(register).toContain('"gen3ia:new-version"');
  });

  it("pwa-register : les sessions longues re-vérifient (poll 30 min + retour d'onglet)", () => {
    const register = read("components/pwa-register.tsx");
    expect(register).toContain("setInterval(checkForUpdate");
    expect(register).toContain("visibilitychange");
    expect(register).toContain("update()");
  });
});

describe("Bannière « nouvelle version » — le signal visible-tab atteint l'UI (étape 19, auto-application Task 51)", () => {
  const banner = read("components/nav/update-banner.tsx");
  const layout = read("app/layout.tsx");

  it("la bannière consomme le signal gen3ia:new-version (chaînon manquant de l'étape 11)", () => {
    expect(banner).toContain('"gen3ia:new-version"');
    expect(banner).toContain("addEventListener");
    // Le listener est retiré au démontage : aucune fuite sur les navigations.
    expect(banner).toContain("removeEventListener");
  });

  it("aucun rendu sans détection : zéro impact initial, pas de bannière fantôme", () => {
    expect(banner).toContain("useState(false)");
    expect(banner).toContain("if (!available || dismissed) return null");
  });

  it("Task 51 — application AUTOMATIQUE demandée : compte à rebours lisible, retenu pendant une saisie, annulable", () => {
    // Évolution de contrat (demande utilisateur explicite) : l'ancien
    // « rechargement par geste explicite uniquement » est remplacé par une
    // application automatique encadrée — compte à rebours VISIBLE de 10 s,
    // RETENUE si l'utilisateur écrit/clique (jamais de coupure à la
    // frappe), annulation « Plus tard ». Voir app/deploy-auto-update.test.ts
    // pour les gardes complets de la chaîne deploy-info → watcher → bannière.
    expect(banner).toContain("AUTO_RELOAD_SECONDS = 10");
    expect(banner).toContain("ACTIVE_GRACE_MS = 4_000");
    expect(banner).toContain("setHolding(true)");
    expect(banner).toContain("window.location.reload()");
  });

  it("« Plus tard » annule le rechargement automatique (l'annonce réapparaît à la prochaine détection)", () => {
    expect(banner).toContain("setDismissed(true)");
    expect(banner).toContain('aria-label="Annuler le rechargement automatique"');
  });

  it("annoncée aux lecteurs d'écran (role=status, aria-live=polite)", () => {
    expect(banner).toContain('role="status"');
    expect(banner).toContain('aria-live="polite"');
  });

  it("montée dans le layout racine, à côté de PwaRegister : présente sur toutes les pages", () => {
    expect(layout).toContain("@/components/nav/update-banner");
    expect(layout).toContain("<UpdateBanner />");
  });
});

describe("Task 99-a — reprise de contrôle, purge des caches et compteur outbox", () => {
  const sw = read("public/sw.js");
  const banner = read("components/nav/offline-banner.tsx");

  /** Extrait le corps du handler "activate" (entre activate et fetch). */
  const activateHandler = (() => {
    const start = sw.indexOf('self.addEventListener("activate"');
    const end = sw.indexOf('self.addEventListener("fetch"', start);
    return sw.slice(start, end);
  })();

  it("activate : clients.claim() — les pages déjà ouvertes passent sous le nouveau SW immédiatement", () => {
    // L'ancien handler appelait matchAll({ type: "window" }) en jetant le
    // résultat : les pages ouvertes restaient sous l'ancien SW jusqu'à un
    // rechargement manuel. claim() déclenche controllerchange côté client
    // (exploité par pwa-register pour appliquer la nouvelle version).
    expect(activateHandler).toContain("self.clients.claim()");
    // skipWaiting conservé à l'installation (garde existant complété).
    expect(sw).toContain("self.skipWaiting()");
  });

  it("activate : purge des caches « gen3ia- » hérités hors liste blanche", () => {
    // Les deux caches légitimes sont explicitement listés dans une structure
    // de type Set, et le handler supprime réellement les autres caches.
    expect(sw).toContain('new Set(["gen3ia-offline-v1", "gen3ia-immutable-v1"])');
    expect(activateHandler).toContain('name.startsWith("gen3ia-")');
    expect(activateHandler).toContain("KEPT_CACHES.has(name)");
    expect(activateHandler).toContain("caches.delete(name)");
  });

  it("les payloads gen3ia-outbox-pending portent pendingCount (longueur réelle de la file)", () => {
    // Trois sites d'émission (post-enqueue, replafonnement, toujours hors
    // ligne) : chacun doit compter la file APRÈS mutation pour que le badge
    // du banner affiche un nombre fidèle.
    const pendingSites = sw.match(/type: "gen3ia-outbox-pending"/g)?.length ?? 0;
    const countedSites = sw.match(/pendingCount: \(await listQueued\(\)\)\.length/g)?.length ?? 0;
    expect(pendingSites).toBeGreaterThanOrEqual(3);
    expect(countedSites).toBeGreaterThanOrEqual(pendingSites);
  });

  it("offline-banner : badge PERSISTANT du nombre de missions en attente (garde FR)", () => {
    // Compteur maintenu côté banner (pas qu'un toast éphémère) : réglé par
    // pendingCount du SW, décrémenté à chaque reprise ou échec définitif.
    expect(banner).toContain("pendingCount");
    expect(banner).toContain('"gen3ia:outbox-flushed"');
    expect(banner).toContain('"gen3ia:outbox-failed"');
    // Garde FR : libellé affiché avec accord singulier/pluriel.
    expect(banner).toContain("en attente d'envoi");
    expect(banner).toContain("1 mission en attente d'envoi");
    expect(banner).toContain("missions en attente d'envoi");
    // Annonce aux lecteurs d'écran, cohérente avec le bandeau hors-ligne.
    expect(banner).toContain('role="status"');
    expect(banner).toContain('aria-live="polite"');
  });
});

describe("Task 100 — push serveur (Web Push / VAPID) : alerte même app fermée", () => {
  const sw = read("public/sw.js");
  const route = read("app/api/push/subscribe/route.ts");
  const notifRepository = read("lib/notifications/repository.ts");

  /** Extrait le corps du handler "push" (entre push et notificationclick). */
  const pushHandler = (() => {
    const start = sw.indexOf('self.addEventListener("push"');
    const end = sw.indexOf('self.addEventListener("notificationclick"', start);
    return sw.slice(start, end);
  })();

  it("le service worker écoute l'événement push (Web Push / VAPID)", () => {
    expect(sw).toContain('self.addEventListener("push"');
  });

  it("ANTI-DOUBLE NOTIFICATION : aucune notification système si une fenêtre de l'app est visible", () => {
    // matchAll incluant les clients non contrôlés + test visibilityState :
    // l'app visible affiche elle-même la notification in-app (cloche) — le
    // SW ne montre PAS la notification système (pas de doublon).
    expect(pushHandler).toContain('self.clients.matchAll({ type: "window", includeUncontrolled: true })');
    expect(pushHandler).toContain('client.visibilityState === "visible"');
    expect(pushHandler).toContain('"focus" in client');
    // Fenêtre visible → retour anticipé (l'app affiche elle-même).
    expect(pushHandler).toContain("if (appVisible) return");
  });

  it("notification système : tag unique ÉCRASANT (pas d'empilement), icônes Gen3ia, deep-link conservé", () => {
    expect(pushHandler).toContain('tag: "gen3ia-notification"');
    expect(pushHandler).toContain('icon: "/icons/icon-192.png"');
    expect(pushHandler).toContain('badge: "/icons/icon-192.png"');
    expect(pushHandler).toContain("data: { url: data.url }");
    // Le handler notificationclick existant ouvre/focus la cible du push.
    expect(sw).toContain('event.notification.data?.url ?? "/dashboard"');
  });

  it("charge utile illisible → repli générique FR (jamais de crash du handler push)", () => {
    expect(pushHandler).toContain('"Une mise à jour de ta mission t\'attend."');
    expect(pushHandler).toContain('"/dashboard"');
  });

  it("route /api/push/subscribe : authentifiée (requireUser) avec POST et DELETE idempotents", () => {
    expect(route).toContain("requireUser");
    expect(route).toContain("export async function POST");
    expect(route).toContain("export async function DELETE");
    expect(route).toContain("upsertPushSubscription");
    expect(route).toContain("deletePushSubscription");
    // Réponse canonique du contrat API.
    expect(route).toContain("errorBody");
    expect(route).toContain("{ ok: true }");
  });

  it("chaque notification créée déclenche le push serveur en fire-and-forget", () => {
    expect(notifRepository).toContain(
      "void sendPushToUser(notification.userId, pushPayloadFromNotification(notification)).catch(() => undefined)",
    );
  });
});
