import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 51 + demande du 2026-10-22 : « à chaque mise à jour le navigateur
 * doit charger automatiquement la nouvelle version sans même que
 * l'utilisateur le sache ».
 *
 * CORRECTIF 2026-10-22 : sur le VPS auto-hébergé, /api/deploy-info
 * retombait sur « local-dev » CONSTANT (chaîne Vercel absente) — le
 * DeployWatcher ne détectait JAMAIS un nouveau déploiement et les onglets
 * ouverts restaient sur l'ancienne version. L'empreinte est désormais le
 * .next/BUILD_ID du build servi (lib/deploy/build-id.ts) : il change à
 * CHAQUE mise en production.
 *
 * Chaîne complète : /api/deploy-info (empreinte = BUILD_ID du build servi,
 * jamais cachée) → DeployWatcher (sonde périodique + retour d'onglet +
 * retour réseau ; onglet caché = rechargement transparent gardé PAR
 * CIBLE ; onglet visible = rechargement DIFFÉRÉ à la prochaine mise en
 * arrière-plan — invisible — puis bannière en filet de sécurité) →
 * UpdateBanner v2 (compte à rebours annulable, retenue de saisie,
 * application auto) ; PwaRegister enregistre le SW à l'épreuve du cache.
 */

vi.mock("@/lib/deploy/build-id", () => ({ readBuildId: vi.fn() }));

import { readBuildId } from "@/lib/deploy/build-id";

const mockBuildId = vi.mocked(readBuildId);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/* --------------------- Endpoint /api/deploy-info ---------------------- */

const ENV_KEYS = ["VERCEL_DEPLOYMENT_ID", "VERCEL_GIT_COMMIT_SHA", "GEN3IA_RELEASE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("Endpoint /api/deploy-info — empreinte du déploiement actif", () => {
  beforeEach(() => {
    mockBuildId.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const grabEnv = () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  };

  it("CORRECTIF 2026-10-22 : le BUILD_ID du build servi est l'empreinte PRIORITAIRE — elle change à chaque déploiement", async () => {
    grabEnv();
    // Même quand l'environnement Vercel est peuplé, le BUILD_ID gagne :
    // c'est lui qui suit le build EFFECTIVEMENT swapé sur le VPS.
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_test";
    process.env.GEN3IA_RELEASE = "release-factice";
    mockBuildId.mockReturnValue("_X5VyoPm2wkmqVd3BpbiX");
    const { GET } = await import("@/app/api/deploy-info/route");
    const response = GET();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; deploymentId: string; generatedAt: string };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe("_X5VyoPm2wkmqVd3BpbiX");
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("l'empreinte suit le swap atomique : deux requêtes successives reflètent un nouveau build", async () => {
    grabEnv();
    mockBuildId.mockReturnValueOnce("build-precedent").mockReturnValueOnce("build-nouveau");
    const { GET } = await import("@/app/api/deploy-info/route");
    const first = (await GET().json()) as { deploymentId: string };
    const second = (await GET().json()) as { deploymentId: string };
    expect(first.deploymentId).toBe("build-precedent");
    expect(second.deploymentId).toBe("build-nouveau");
  });

  it("chaîne de repli : GEN3IA_RELEASE → variables Vercel → local-dev — l'empreinte n'est JAMAIS vide", async () => {
    grabEnv();
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GEN3IA_RELEASE;
    const { GET } = await import("@/app/api/deploy-info/route");
    const body = (await GET().json()) as { deploymentId: string };
    expect(body.deploymentId).toBe("local-dev");
    expect(body.deploymentId.length).toBeGreaterThan(0);
  });

  it("repli GEN3IA_RELEASE (auto-hébergement) quand BUILD_ID et Vercel sont absents", async () => {
    grabEnv();
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.GEN3IA_RELEASE = "release-2026.10";
    const { GET } = await import("@/app/api/deploy-info/route");
    const body = (await GET().json()) as { deploymentId: string };
    expect(body.deploymentId).toBe("release-2026.10");
  });

  it("repli variables Vercel quand BUILD_ID et GEN3IA_RELEASE sont absents", async () => {
    grabEnv();
    process.env.VERCEL_GIT_COMMIT_SHA = "sha-1";
    const { GET } = await import("@/app/api/deploy-info/route");
    const body = (await GET().json()) as { deploymentId: string };
    expect(body.deploymentId).toBe("sha-1");
  });

  it("l'empreinte est lue À LA REQUÊTE : le swap de .next est visible dès la requête suivante", async () => {
    grabEnv();
    mockBuildId.mockReturnValueOnce("avant-swap").mockReturnValueOnce("apres-swap");
    const { GET } = await import("@/app/api/deploy-info/route");
    const first = (await GET().json()) as { deploymentId: string };
    const second = (await GET().json()) as { deploymentId: string };
    expect(first.deploymentId).toBe("avant-swap");
    expect(second.deploymentId).toBe("apres-swap");
  });

  it("reste ULTRA-LÉGER : next/server + lecture BUILD_ID uniquement — aucune dépendance base de données ni SDK lourd (sondé ~90 s par onglet)", () => {
    const route = read("app/api/deploy-info/route.ts");
    // Garde sur les IMPORTS réels (pas les commentaires de design) : la
    // route ne doit jamais grossir d'une dépendance applicative.
    const imports = route.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      'import { NextResponse } from "next/server";',
      'import { readBuildId } from "@/lib/deploy/build-id";',
    ]);
    // Aucun import lourd (Firebase, Redis, SDK applicatif) dans la route.
    for (const imp of imports) {
      expect(imp).not.toMatch(/firebase|firestore|redis|@\/lib\/(?!deploy)/);
    }
    expect(route).toContain('export const dynamic = "force-dynamic"');
    expect(route).toContain('export const runtime = "nodejs"');
  });
});

/* ---------------------------- DeployWatcher --------------------------- */

describe("DeployWatcher — détection du nouveau build sans navigation", () => {
  const watcher = read("components/deploy-watcher.tsx");

  it("sonde /api/deploy-info sans cache et sans pendre (timeout réseau borné)", () => {
    expect(watcher).toContain('"/api/deploy-info"');
    expect(watcher).toContain('cache: "no-store"');
    expect(watcher).toContain("AbortSignal.timeout(POLL_TIMEOUT_MS)");
  });

  it("cadence 90 s avec jitter ±25 % : les onglets ne sondent pas en vague", () => {
    expect(watcher).toContain("DEPLOY_POLL_MS = 90_000");
    expect(watcher).toContain("DEPLOY_POLL_JITTER = 0.25");
    expect(watcher).toContain("Math.random() * 2 - 1");
    expect(watcher).toContain("window.setTimeout");
  });

  it("premier relevé = RÉFÉRENCE : jamais d'application au démarrage (boucle impossible)", () => {
    expect(watcher).toContain("if (baseline === null)");
    expect(watcher).toContain("baseline = id");
    // La référence est posée AVANT toute décision d'application.
    expect(watcher.indexOf("if (baseline === null)")).toBeLessThan(
      watcher.indexOf("applyDetectedDeployment(id)"),
    );
  });

  it("onglet caché = rechargement transparent gardé PAR CIBLE (sessionStorage survit au reload)", () => {
    expect(watcher).toContain('RELOAD_FLAG_PREFIX = "gen3ia-deploy-reloaded:"');
    expect(watcher).toContain('document.visibilityState === "hidden"');
    expect(watcher).toContain("canTryReload(id)");
    expect(watcher).toContain("window.location.reload()");
    // Repli quand le stockage est indisponible : au plus un rechargement
    // par chargement de page.
    expect(watcher).toContain("reloadedWithoutStorage");
  });

  it("DEMANDE 2026-10-22 : onglet visible = rechargement DIFFÉRÉ à la prochaine mise en arrière-plan (invisibilité)", () => {
    expect(watcher).toContain("VISIBLE_DEFER_MS = 30_000");
    // La détection pendant que l'onglet est visible ne coupe JAMAIS la page :
    // le rechargement attend la mise en arrière-plan (onHidden).
    expect(watcher).toContain("deferredTarget");
    expect(watcher).toContain('document.addEventListener("visibilitychange", onHidden)');
    expect(watcher).toContain("window.clearTimeout(fallbackTimer)");
    // Filet de sécurité : onglet resté au premier plan → bannière.
    expect(watcher).toContain("announceOnce");
  });

  it("bannière = filet de sécurité : signal gen3ia:new-version UNE seule fois par cible (déduplication)", () => {
    expect(watcher).toContain('"gen3ia:new-version"');
    expect(watcher).toContain("notifiedTargets.has(id)");
    expect(watcher).toContain("notifiedTargets.add(id)");
  });

  it("déclencheurs : période + retour d'onglet (throttle 30 s) + passage en arrière-plan + retour réseau (natif online)", () => {
    expect(watcher).toContain("VISIBILITY_MIN_GAP_MS = 30_000");
    expect(watcher).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(watcher).toContain('document.addEventListener("visibilitychange", onHidden)');
    expect(watcher).toContain('window.addEventListener("online", onOnline)');
  });

  it("anti-concurrence des sondes et nettoyage complet au démontage (aucune fuite)", () => {
    expect(watcher).toContain("checkInFlight");
    expect(watcher).toContain("window.clearTimeout(timer)");
    expect(watcher).toContain('document.removeEventListener("visibilitychange", onVisible)');
    expect(watcher).toContain('document.removeEventListener("visibilitychange", onHidden)');
    expect(watcher).toContain('window.removeEventListener("online", onOnline)');
    expect(watcher).toContain("return null");
  });
});

/* --------------------- Mise à jour forcée — plan 4 étapes ------------------ */

describe("Mise à jour forcée — manifeste version.json aligné sur le BUILD_ID (plan 2026-10-23, étape 2)", () => {
  it("le build écrit public/version.json : init AVANT next build, finalize APRÈS (version = BUILD_ID)", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe(
      "node scripts/version-manifest.mjs init && next build && node scripts/version-manifest.mjs finalize",
    );
  });

  it("le manifeste est un artefact gitignored (aucune valeur périmée committée)", () => {
    expect(read(".gitignore")).toContain("/public/version.json");
  });

  it("en-tête serveur : /version.json JAMAIS cachable (couche Next — plan étape 1 côté app)", () => {
    const config = read("next.config.ts");
    expect(config).toContain('source: "/version.json"');
    expect(config).toContain('value: "no-store, no-cache, must-revalidate"');
  });

  it("chaîne CD : le tar n'embarque que .next → cd-finisher copie .next/version.json dans public/ APRÈS git reset", () => {
    const finisher = read("deploy/cd-finisher.sh");
    expect(finisher).toContain('cp "$STAGING_DIR/.next/version.json" "$PROD_DIR/public/version.json"');
    expect(finisher.indexOf("git reset --hard")).toBeLessThan(
      finisher.indexOf('cp "$STAGING_DIR/.next/version.json"'),
    );
  });

  it("vérification de fin de déploiement : deploy-info ET version.json == BUILD_ID — sinon workflow ROUGE (plan étape 4)", () => {
    const workflow = read(".github/workflows/deploy-vps.yml");
    expect(workflow).toContain("http://127.0.0.1:3000/version.json");
    expect(workflow).toContain('[ "$empreinte" = "$BUILD_ID" ] && [ "$manifeste" = "$BUILD_ID" ]');
    // Le manifeste est indenté (JSON.stringify p=2) : le grep doit porter
    // sur la réponse COMPACTÉE, sinon un déploiement correct passe rouge
    // (régression du run #34).
    expect(workflow).toContain("tr -d ' \\n\\r'");
    expect(workflow.indexOf("compacte=")).toBeLessThan(workflow.indexOf('grep -o \'"version"'));
  });

  it("le snippet nginx (étape 1) protège le cache immutable des assets hashés tout en interdisant le cache HTML/JSON", () => {
    const nginx = read("deploy/nginx/gen3ia-cache.conf");
    expect(nginx).toContain("location ^~ /_next/static/");
    expect(nginx).toContain("location = /version.json");
    expect(nginx).toContain("location ~* \\.(html|json)$");
    // Ordre de priorité : ^~ (immuable) déclaré AVANT le regex HTML/JSON.
    expect(nginx.indexOf("location ^~ /_next/static/")).toBeLessThan(nginx.indexOf("location ~* \\.(html|json)$"));
  });
});

describe("DeployWatcher — sonde version.json + persistance inter-sessions (plan 2026-10-23, étape 3)", () => {
  const watcher = read("components/deploy-watcher.tsx");

  it("seconde sonde INDÉPENDANTE : /version.json avec cache-buster et no-store", () => {
    expect(watcher).toContain('VERSION_MANIFEST_URL = "/version.json"');
    expect(watcher).toContain("`${VERSION_MANIFEST_URL}?t=${Date.now()}`");
    expect(watcher).toContain('cache: "no-store"');
    expect(watcher).toContain("AbortSignal.timeout(POLL_TIMEOUT_MS)");
  });

  it("sondes en PARALLÈLE ; l'API fait foi, le manifeste statique prend le relais si elle est muette", () => {
    expect(watcher).toContain("Promise.all([fetchDeploymentId(), fetchManifestVersion()])");
    expect(watcher).toContain("apiId ?? manifestVersion");
  });

  it("ambiguïté (bascule/rollback) : sources divergentes → AUCUNE décision ce cycle", () => {
    expect(watcher).toContain("apiId !== null && manifestVersion !== null && apiId !== manifestVersion");
  });

  it("persistance inter-sessions : localStorage gen3ia-app-version — page périmée détectée dès le premier relevé", () => {
    expect(watcher).toContain('APP_VERSION_KEY = "gen3ia-app-version"');
    expect(watcher).toContain("readStoredVersion()");
    expect(watcher).toContain('localStorage.getItem(APP_VERSION_KEY)');
    expect(watcher).toContain("if (stored !== null && stored !== id)");
  });

  it("la version est écrite dans le stockage AVANT toute application — anti-boucle du plan utilisateur", () => {
    const firstStore = watcher.indexOf("storeAppVersion(id)");
    const firstApply = watcher.indexOf("applyDetectedDeployment(id);");
    expect(firstStore).toBeGreaterThan(-1);
    expect(firstApply).toBeGreaterThan(-1);
    expect(firstStore).toBeLessThan(firstApply);
    // L'écriture tolère un stockage indisponible (navigation privée stricte).
    expect(watcher).toMatch(/try \{[\s\S]*localStorage\.setItem\(APP_VERSION_KEY, version\)[\s\S]*\} catch/);
  });
});

/* --------------------------- UpdateBanner v2 -------------------------- */

describe("UpdateBanner v2 — application AUTOMATIQUE contractée (Task 51)", () => {
  const banner = read("components/nav/update-banner.tsx");

  it("compte à rebours VISIBLE (10 s) puis rechargement automatique au terme", () => {
    expect(banner).toContain("AUTO_RELOAD_SECONDS = 10");
    expect(banner).toContain("window.setInterval(tick, 1000)");
    expect(banner).toContain("window.location.reload()");
    // Le nombre défilant est exclu des lecteurs d'écran (pas d'annonce par seconde).
    expect(banner).toContain('aria-hidden');
  });

  it("RETENUE DE SAISIE : keydown/pointerdown récents → rechargement différé, jamais de coupure à la frappe", () => {
    expect(banner).toContain("ACTIVE_GRACE_MS = 4_000");
    expect(banner).toContain("HOLD_CHECK_MS = 2_000");
    expect(banner).toContain('window.addEventListener("keydown", markInteraction, { capture: true, passive: true })');
    expect(banner).toContain('window.addEventListener("pointerdown", markInteraction, { capture: true, passive: true })');
    expect(banner).toContain("setHolding(true)");
  });

  it("annulation explicite (« Plus tard ») démonte le compte à rebours sans recharger", () => {
    expect(banner).toContain('onClick={() => setDismissed(true)}');
    expect(banner).toContain('aria-label="Annuler le rechargement automatique"');
    // La sortie d'effet (annulation OU démontage) arrête le minuteur.
    expect(banner).toContain("window.clearInterval(timer)");
  });

  it("« Recharger » reste disponible : accélération immédiate au choix de l'utilisateur", () => {
    expect(banner).toContain('onClick={() => window.location.reload()}');
    expect(banner).toContain("Recharger");
  });

  it("annonce et réapparition : chaque NOUVELLE détection réarme l'annonce (jamais de boucle)", () => {
    expect(banner).toContain("setAvailable(true)");
    expect(banner).toContain("setDismissed(false)");
    expect(banner).toContain("removeEventListener");
    expect(banner).toContain("if (!available || dismissed) return null");
  });

  it("a11y conservée (role=status, aria-live=polite) et thème --g3-* uniquement", () => {
    expect(banner).toContain('role="status"');
    expect(banner).toContain('aria-live="polite"');
    expect(banner).toContain("var(--g3-text)");
  });

  it("suivi d'interaction nettoyé au démontage (aucune fuite de listener)", () => {
    expect(banner).toContain('window.removeEventListener("keydown", markInteraction, { capture: true })');
    expect(banner).toContain('window.removeEventListener("pointerdown", markInteraction, { capture: true })');
  });
});

/* --------------------------- PwaRegister ------------------------------ */

describe("PwaRegister — enregistrement du service worker à l'épreuve du cache", () => {
  const pwa = read("components/pwa-register.tsx");

  it("updateViaCache 'none' : le sw.js sondé par reg.update() ne provient JAMAIS du cache HTTP navigateur", () => {
    expect(pwa).toContain('updateViaCache: "none"');
  });

  it("double ceinture avec l'en-tête serveur : sw.js revalidé à chaque visite", () => {
    const config = read("next.config.ts");
    expect(config).toContain('source: "/sw.js"');
    expect(config).toContain('value: "public, max-age=0, must-revalidate"');
  });
});

/* --------------------------- lib/deploy/build-id ---------------------- */

describe("lib/deploy/build-id — lecture du BUILD_ID servi", () => {
  it("l'empreinte vient de .next/BUILD_ID (fichier régénéré à chaque build, swappé à chaque déploiement)", () => {
    const source = read("lib/deploy/build-id.ts");
    expect(source).toContain('".next"');
    expect(source).toContain('"BUILD_ID"');
    expect(source).toContain("process.cwd()");
  });

  it("ne lève JAMAIS d'exception : BUILD_ID absent → null (repli côté appelant)", () => {
    const source = read("lib/deploy/build-id.ts");
    // Le try/catch englobe la lecture — aucun crash possible dans la sonde.
    expect(source).toMatch(/try \{[\s\S]*readFileSync[\s\S]*\} catch/);
  });

  it("cwd injectable pour la testabilité (aucune dépendance implicite au process courant)", () => {
    const source = read("lib/deploy/build-id.ts");
    expect(source).toContain("cwd: string = process.cwd()");
  });
});

/* ------------------------------ Câblage ------------------------------- */

describe("Layout racine — chaîne complète présente sur toutes les pages", () => {
  const layout = read("app/layout.tsx");

  it("DeployWatcher et UpdateBanner montés à côté de PwaRegister", () => {
    expect(layout).toContain("@/components/deploy-watcher");
    expect(layout).toContain("<DeployWatcher />");
    expect(layout).toContain("@/components/nav/update-banner");
    expect(layout).toContain("<UpdateBanner />");
    expect(layout).toContain("<PwaRegister />");
  });
});
