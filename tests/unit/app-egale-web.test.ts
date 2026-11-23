import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ÉQUIVALENCE APP ≡ WEB — la demande : « la version app doit être
 * fonctionnelle et connectée à la version site web (mise à jour
 * automatique), et tester que la version app fonctionne bien comme la
 * version site web ».
 *
 * Ces gardes vérifient STRUCTURELLEMENT que l'app installée (PWA) et le
 * site sont la MÊME application, alimentée par la même chaîne :
 *  · même document (manifest : start_url "/", scope "/", standalone) et
 *    icônes réelles (PNG ouverts et mesurés, pas de références fantômes) ;
 *  · le service worker n'altère JAMAIS le contenu : navigations
 *    réseau-d'abord (le même HTML que le navigateur), /api jamais mises
 *    en cache (mêmes données personnelles), offline.html en dernier
 *    recours uniquement ;
 *  · même session : le SW laisse passer les requêtes réelles (credentials
 *    du navigateur, aucune réécriture) ;
 *  · une seule chaîne de mise à jour pour app ET web : le même build
 *    écrit /version.json (init && next build && finalize), les deux
 *    sondes (API + manifeste statique) rechargent automatiquement —
 *    l'app installée suit donc exactement la version du site ;
 *  · installation IN-APP depuis les Paramètres (beforeinstallprompt +
 *    état installé + guide iOS) et statut de mise à jour visible.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const readBuffer = (file: string) => readFileSync(path.join(process.cwd(), file));

/** Dimensions PNG réelles : IHDR (largeur/hauteur en octets 16-23). */
function dimensionsPng(buffer: Buffer): { largeur: number; hauteur: number } {
  expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // signature PNG
  return { largeur: buffer.readUInt32BE(16), hauteur: buffer.readUInt32BE(20) };
}

describe("même document : l'app installée EST le site", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    lang: string;
    name: string;
    short_name: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };

  it("racine unique : même origine, même point d'entrée, plein écran (standalone)", () => {
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("fr");
    // URLs relatives : l'app ne peut jamais pointer vers un autre domaine
    // (elle reste connectée à CE site, session et données comprises).
    for (const icone of manifest.icons) {
      expect(icone.src.startsWith("/")).toBe(true);
    }
  });

  it("identité app ≡ site : le même nom Gen3ia côté manifest et brand", () => {
    expect(manifest.short_name).toBe("Gen3ia");
    expect(manifest.name).toContain("Gen3ia");
  });

  it("icônes RÉELLES : chaque icône du manifest existe sur disque aux dimensions annoncées", () => {
    for (const icone of manifest.icons) {
      const chemin = path.join(process.cwd(), "public", icone.src.split("?")[0]);
      expect(existsSync(chemin)).toBe(true);
      const { largeur, hauteur } = dimensionsPng(readBuffer(path.relative(process.cwd(), chemin)));
      const [tailleAnnoncee] = icone.sizes.split(" ");
      expect(`${largeur}x${hauteur}`).toBe(tailleAnnoncee);
    }
    // Une icône MASKABLE (Android, installée) est requise pour l'app.
    expect(manifest.icons.some((icone) => icone.purpose === "maskable")).toBe(true);
  });
});

describe("le service worker n'altère jamais le contenu (app ≡ web, octet pour octet)", () => {
  const sw = read("public/sw.js");

  it("navigations : réseau D'ABORD — l'app installée reçoit le MÊME HTML que le navigateur", () => {
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw.indexOf("return await fetch(request)")).toBeGreaterThan(-1);
    // offline.html UNIQUEMENT en cas d'échec réseau (jamais à la place du site).
    expect(sw).toContain("/offline.html");
    expect(sw).toContain("OFFLINE_URL");
  });

  it("/api jamais mises en cache : mêmes données personnelles dans l'app que sur le site", () => {
    // Les seuls POST mis en file : création de tâche workspace (rejouée avec
    // idempotence) — aucune autre requête API n'est interceptée ni modifiée.
    expect(sw).toContain('new Set(["/api/workspace/tasks"])');
    expect(sw).toContain("QUEUED_PATHS.has(url.pathname)");
    // Les GET d'API ne passent PAS par le cache-first (réservé aux statiques).
    expect(sw).toContain('IMMUTABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))');
  });

  it("même session : les requêtes traversent le SW sans réécriture (credentials navigateur)", () => {
    // Les navigations et l'envoi hors-ligne utilisent la requête/réponse
    // réelle — aucun rewrite d'URL ni d'en-tête d'authentification.
    expect(sw).toContain("url.origin !== self.location.origin");
    expect(sw).toContain('credentials: "include"');
  });

  it("app utilisable hors ligne : la page de reprise existe et parle de l'app", () => {
    expect(existsSync(path.join(process.cwd(), "public/offline.html"))).toBe(true);
    const offline = read("public/offline.html");
    expect(offline.length).toBeGreaterThan(200);
    expect(offline).toMatch(/Gen3ia/i);
  });
});

describe("chaîne de mise à jour AUTOMATIQUE partagée par l'app et le web", () => {
  const sw = read("public/sw.js");
  const pwaRegister = read("components/pwa-register.tsx");
  const watcher = read("components/deploy-watcher.tsx");
  const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

  it("le nouveau build prend le contrôle des pages ouvertes (skipWaiting + clients.claim)", () => {
    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("await self.clients.claim()");
  });

  it("pwa-register : sw.js sondé SANS cache (une nouvelle version ne peut pas être aveuglée)", () => {
    expect(pwaRegister).toContain('register("/sw.js"');
    expect(pwaRegister).toContain('updateViaCache: "none"');
    expect(pwaRegister).toContain("applyNewVersion");
  });

  it("DeployWatcher : double sonde (API + manifeste statique) et rechargement automatique gardé", () => {
    expect(watcher).toContain('"/api/deploy-info"');
    expect(watcher).toContain('"/version.json"');
    // Anti-boucle : un rechargement maximum PAR DÉPLOIEMENT et par onglet.
    expect(watcher).toContain("RELOAD_FLAG_PREFIX");
    expect(watcher).toContain("canTryReload");
    // Version écrite AVANT le rechargement (persistée inter-sessions).
    expect(watcher).toContain('"gen3ia-app-version"');
    expect(watcher).toContain("storeAppVersion");
  });

  it("le build écrit /version.json : app et web suivent LA MÊME empreinte (BUILD_ID)", () => {
    expect(packageJson.scripts?.build).toMatch(/version-manifest\.mjs init && next build && node scripts\/version-manifest\.mjs finalize/);
    // Le watcher exige la cohérence des deux sources avant toute application.
    expect(watcher).toContain("apiId !== manifestVersion");
  });
});

describe("installation depuis les Paramètres + statut de mise à jour visible", () => {
  const settings = read("app/settings/page.tsx");
  const installSection = read("components/settings/pwa-install-section.tsx");
  const installButton = read("components/pwa/install-button.tsx");
  const updateStatus = read("components/settings/pwa-update-status.tsx");
  const statutApp = read("lib/app/statut-app.ts");

  it("la page Paramètres monte la section Application (point d'installation in-app)", () => {
    expect(settings).toContain("PwaInstallSection");
    expect(installSection).toContain("Application");
  });

  it("installation native réelle : beforeinstallprompt capturé + état installé détecté", () => {
    expect(installButton).toContain("beforeinstallprompt");
    expect(installButton).toContain("useStandaloneInstalled");
    // iOS sans prompt programmable : guide « Sur l'écran d'accueil ».
    expect(installSection).toContain("Sur l'écran d'accueil");
  });

  it("statut de mise à jour : l'app installée affiche sa version et la mise à jour automatique", () => {
    // Monté dans la section Application des Paramètres.
    expect(installSection).toContain("PwaUpdateStatus");
    // Lit les DEUX mêmes sondes que le watcher (cohérence totale de la chaîne).
    expect(updateStatus).toContain('"/api/deploy-info"');
    expect(updateStatus).toContain("/version.json");
    expect(updateStatus).toContain("gen3ia-app-version");
    // Pousse le service worker à re-sonder (Vérifier maintenant).
    expect(updateStatus).toContain("reg?.update()");
  });

  it("statut honnête : sondes divergentes ou hors-ligne → indéterminé, jamais de faux « à jour »", () => {
    expect(statutApp).toContain('"indetermine"');
    expect(statutApp).toContain("apiId !== manifestVersion");
  });

  it("le watcher est monté au layout racine : l'app installée et le web partagent le même mécanisme", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain("<DeployWatcher />");
    expect(layout).toContain("<PwaRegister />");
  });
});
