import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Task 51 — rechargement automatique après chaque build Vercel (demande
 * utilisateur explicite : « après que Vercel a terminé le build, le
 * navigateur doit pouvoir charger les modifications automatiquement »).
 *
 * Chaîne complète : /api/deploy-info (empreinte du déploiement actif,
 * jamais cachée) → DeployWatcher (sonde périodique + retour d'onglet +
 * retour réseau ; onglet caché = rechargement transparent gardé PAR
 * CIBLE ; onglet visible = signal gen3ia:new-version) → UpdateBanner v2
 * (compte à rebours annulable, retenue de saisie, application auto).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/* --------------------- Endpoint /api/deploy-info ---------------------- */

const ENV_KEYS = ["VERCEL_DEPLOYMENT_ID", "VERCEL_GIT_COMMIT_SHA", "GEN3IA_RELEASE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("Endpoint /api/deploy-info — empreinte du déploiement actif", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const grabEnv = () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  };

  it("réponse réelle : empreinte Vercel prioritaire + Cache-Control no-store strict", async () => {
    grabEnv();
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_test_prioritaire";
    process.env.VERCEL_GIT_COMMIT_SHA = "commitabc123";
    const { GET } = await import("./api/deploy-info/route");
    const response = GET();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; deploymentId: string; generatedAt: string };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe("dpl_test_prioritaire");
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("chaîne de repli : commit → GEN3IA_RELEASE → local-dev — l'empreinte n'est JAMAIS vide", async () => {
    grabEnv();
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GEN3IA_RELEASE;
    const { GET } = await import("./api/deploy-info/route");
    const response = GET();
    const body = (await response.json()) as { deploymentId: string };
    expect(body.deploymentId).toBe("local-dev");
    expect(body.deploymentId.length).toBeGreaterThan(0);
  });

  it("repli GEN3IA_RELEASE (auto-hébergement) quand Vercel est absent", async () => {
    grabEnv();
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.GEN3IA_RELEASE = "release-2026.10";
    const { GET } = await import("./api/deploy-info/route");
    const body = (await GET().json()) as { deploymentId: string };
    expect(body.deploymentId).toBe("release-2026.10");
  });

  it("l'empreinte est lue À LA REQUÊTE (deux appels successifs suivent l'environnement)", async () => {
    grabEnv();
    delete process.env.VERCEL_DEPLOYMENT_ID;
    process.env.VERCEL_GIT_COMMIT_SHA = "sha-1";
    const { GET } = await import("./api/deploy-info/route");
    const first = (await GET().json()) as { deploymentId: string };
    process.env.VERCEL_GIT_COMMIT_SHA = "sha-2";
    const second = (await GET().json()) as { deploymentId: string };
    expect(first.deploymentId).toBe("sha-1");
    expect(second.deploymentId).toBe("sha-2");
  });

  it("reste ULTRA-LÉGER : seul import next/server — aucune dépendance base de données ni SDK lourd (sondé ~90 s par onglet)", () => {
    const route = read("app/api/deploy-info/route.ts");
    // Garde sur les IMPORTS réels (pas les commentaires de design) : la
    // route ne doit jamais grossir d'une dépendance applicative.
    const imports = route.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(['import { NextResponse } from "next/server";']);
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

  it("onglet visible = signal gen3ia:new-version UNE seule fois par cible (déduplication)", () => {
    expect(watcher).toContain('"gen3ia:new-version"');
    expect(watcher).toContain("notifiedTargets.has(id)");
    expect(watcher).toContain("notifiedTargets.add(id)");
  });

  it("déclencheurs : période + retour d'onglet (throttle 30 s) + retour réseau (natif online)", () => {
    expect(watcher).toContain("VISIBILITY_MIN_GAP_MS = 30_000");
    expect(watcher).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(watcher).toContain('window.addEventListener("online", onOnline)');
  });

  it("anti-concurrence des sondes et nettoyage complet au démontage (aucune fuite)", () => {
    expect(watcher).toContain("checkInFlight");
    expect(watcher).toContain("window.clearTimeout(timer)");
    expect(watcher).toContain('document.removeEventListener("visibilitychange", onVisible)');
    expect(watcher).toContain('window.removeEventListener("online", onOnline)');
    expect(watcher).toContain("return null");
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
