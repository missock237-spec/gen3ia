import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  classifyApiPath,
  classifyPagePath,
  createCachedAdminResolver,
  isAdminActor,
  normalizePathname,
} from "./user-access";

/**
 * Matrice de la liste blanche d'accès utilisateur (demande n°7).
 *
 * Chaque assertion de cette suite est un point de la matrice allow/deny
 * documentée dans la PR : ce fichier EST la spécification exécutable.
 */

describe("normalizePathname", () => {
  it("supprime les slashes finaux (sauf racine)", () => {
    expect(normalizePathname("/chat/")).toBe("/chat");
    expect(normalizePathname("/chat///")).toBe("/chat");
    expect(normalizePathname("/")).toBe("/");
    expect(normalizePathname("/chat")).toBe("/chat");
  });
});

describe("API — chemins PUBLICS (préservés, anonyme inclus)", () => {
  const publics = [
    "/api/health",
    "/api/health/infra",
    "/api/neural/public-stats",
    "/api/status",
    "/api/deploy-info",
    "/api/auth/session",
    "/api/auth/access",
    "/api/auth/account",
    "/api/auth/profile",
    "/api/auth/r2/login",
    "/api/auth/r2/signup",
    "/api/auth/r2/password-reset",
    "/api/auth/r2/password-reset/confirm",
    "/api/public/health",
    "/api/public/sdk",
    "/api/public/agents/ag1",
    "/api/public/commercial/slug",
    "/api/webhooks/chariow",
    "/api/webhooks/agent-triggers/tok123",
    "/api/cron/agent-schedules",
    "/api/cron/training-sweep",
    "/api/queue/dispatch-tick",
    "/api/queue/mission-tick",
    "/api/video/worker/tick",
    "/api/video/worker/production-tick",
  ];

  it.each(publics)("%s → public", (path) => {
    expect(classifyApiPath(path)).toMatchObject({ access: "public" });
  });

  it("trailing slash → public (normalisation)", () => {
    expect(classifyApiPath("/api/health/")).toMatchObject({ access: "public" });
  });
});

describe("API — liste blanche UTILISATEUR (14 familles de la demande)", () => {
  const utilisateurs = [
    // Chat IA
    ["/api/chat/message", "chat"],
    ["/api/chat/conversations", "chat"],
    ["/api/chat/conversations/c1", "chat"],
    ["/api/agent/chat", "chat"],
    ["/api/agent/chat/approve", "chat"],
    ["/api/ai/feedback", "chat"],
    ["/api/workspace/conversations", "chat"],
    ["/api/workspace/conversations/c1/messages/stream", "chat"],
    ["/api/workspace/conversations/search", "chat"],
    ["/api/workspace/approvals/a1", "chat"],
    ["/api/workspace/prompt-templates", "chat"],
    ["/api/workspace/prompt-templates/t1", "chat"],
    // Studio d'entraînement (+ configuration)
    ["/api/training/catalog", "training"],
    ["/api/training/projects", "training"],
    ["/api/training/projects/p1/datasets", "training"],
    ["/api/training/projects/p1/plans", "training"],
    ["/api/training/jobs/j1/cancel", "training"],
    ["/api/training/hub/search", "training"],
    ["/api/ia/auto-apprentissage", "training"],
    // Connecteurs
    ["/api/custom-apis", "connecteurs"],
    ["/api/custom-apis/ca1/call", "connecteurs"],
    // Planifications (seule famille /api/agents autorisée)
    ["/api/agents/schedules", "planifications"],
    ["/api/agents/schedules/s1", "planifications"],
    ["/api/agents/schedules/s1/run", "planifications"],
    ["/api/agents/schedules/s1/runs", "planifications"],
    ["/api/agents/schedules/s1/watch", "planifications"],
    // Facturation
    ["/api/billing/plans", "facturation"],
    ["/api/billing/plans/checkout", "facturation"],
    ["/api/billing/topup/verify", "facturation"],
    ["/api/billing/transactions", "facturation"],
    ["/api/billing/wallet", "facturation"],
    // Paramètres
    ["/api/settings/preferences", "parametres"],
    ["/api/settings/api-keys", "parametres"],
    ["/api/settings/export-data", "parametres"],
    ["/api/settings/tool-consents", "parametres"],
    // Base de connaissances
    ["/api/knowledge", "connaissances"],
    ["/api/knowledge/triggers", "connaissances"],
    ["/api/knowledge/triggers/t1", "connaissances"],
    // Projets
    ["/api/workspace/projects", "projets"],
    ["/api/workspace/projects/p1", "projets"],
    // Fichiers (+ artefacts, stockage permanent, capture)
    ["/api/files/read", "fichiers"],
    ["/api/files/write", "fichiers"],
    ["/api/files/workspaces", "fichiers"],
    ["/api/files/artifacts/a1", "fichiers"],
    ["/api/files/import", "fichiers"],
    ["/api/documents/a1", "fichiers"],
    ["/api/workspace/artifacts", "fichiers"],
    ["/api/storage/permanent", "fichiers"],
    ["/api/storage/permanent/session", "fichiers"],
    ["/api/storage/plan", "fichiers"],
    ["/api/camera/request", "fichiers"],
    // Automatisation (exécution pilotée depuis la conversation)
    ["/api/workspace/tasks", "automatisation"],
    ["/api/workspace/tasks/t1/execute", "automatisation"],
    ["/api/workspace/missions", "automatisation"],
    // Intégrations
    ["/api/integrations/status", "integrations"],
    ["/api/integrations/catalog", "integrations"],
    ["/api/integrations/composio/connect", "integrations"],
    ["/api/integrations/composio/connections", "integrations"],
    ["/api/integrations/composio/tools", "integrations"],
    ["/api/integrations/mcp", "integrations"],
    ["/api/integrations/mention", "integrations"],
    ["/api/integrations/messaging/preferences", "integrations"],
    ["/api/integrations/webhooks", "integrations"],
    // Observabilité (vue personnelle)
    ["/api/observability/overview", "observabilite"],
    // Mémoire permanente
    ["/api/memory", "memoire"],
    ["/api/memory/search", "memoire"],
    ["/api/memory/export", "memoire"],
    ["/api/memory/consent", "memoire"],
    ["/api/memory/purge", "memoire"],
    // STUDIO MÉTIER (réouverture propriétaire) — atelier vidéo
    ["/api/video/projects", "studio"],
    ["/api/video/projects/p1", "studio"],
    ["/api/video/projects/p1/render", "studio"],
    // Workshop agent « Gen IA » (liste + provisionnement) — l'orchestration
    // (/run, /generate, /plan) reste gardée AU NIVEAU DE LA ROUTE.
    ["/api/agents", "studio"],
    ["/api/agents/a1", "studio"],
    // Suivi de mission (lecture propriétaire, non-pilotage)
    ["/api/agents/runs/r1", "studio"],
    // AGENT LIVE (réouverture propriétaire — PC + Android)
    ["/api/live/sessions", "live"],
    ["/api/live/sessions/s1", "live"],
    ["/api/live/sessions/s1/frames", "live"],
  ] as const;

  it.each(utilisateurs)("%s → user (%s)", (path, family) => {
    expect(classifyApiPath(path)).toMatchObject({ access: "user", family });
  });
});

describe("API — RESTREINT (deny-by-default, hors demande n°7)", () => {
  const restreints = [
    // Admin
    "/api/admin/users",
    "/api/admin/observability",
    "/api/admin/security",
    // Agents — orchestration RÉSERVÉE au niveau route (requireAgentSystemAccess)
    // même si le PRÉFIXE /api/agents est atteignable (défense en profondeur)
    "/api/agents/run",
    "/api/agents/generate",
    "/api/agents/plan",
    // ⚠️ frontière critique : /api/agents/schedules reste autorisé
    // Ads
    "/api/ads/generate",
    "/api/ads/connect",
    "/api/ads/callback",
    // Business (studio métier)
    "/api/business/automations",
    "/api/business/pulse",
    // Neural (hors stats publiques)
    "/api/neural/train",
    "/api/neural/state",
    "/api/neural/brain",
    // Divers modules non demandés
    "/api/identity/twin",
    "/api/monde/simuler",
    "/api/ondes/signaling",
    "/api/networks",
    "/api/orchestrator",
    "/api/skills",
    "/api/terminal/exec",
    "/api/tools/execute",
    "/api/workflows",
    "/api/deployments/create",
    "/api/provisioning/intent",
    "/api/organizations",
    "/api/teams",
    "/api/team/t1/memory",
    "/api/extensions",
    "/api/developer/api-keys",
    "/api/developer/terminal",
    "/api/capabilities",
    "/api/notifications",
    "/api/push/subscribe",
    "/api/commercial",
    "/api/v1/agents/a1/run",
    // Observabilité : seule la vue personnelle est autorisée
    "/api/observability/org",
    // Inconnu → deny
    "/api/inconnue",
    "/api",
  ];

  it.each(restreints)("%s → restreint", (path) => {
    expect(classifyApiPath(path)).toMatchObject({ access: "restreint" });
  });

  it("ne confond PAS /api/agents/schedules (user) avec /api/agents (user studio)", () => {
    expect(classifyApiPath("/api/agents/schedules").access).toBe("user");
    expect(classifyApiPath("/api/agents/schedule-x").access).toBe("user");
    expect(classifyApiPath("/api/agents/schedules").family).toBe("planifications");
    // Le préfixe /api/agents est atteignable, l'orchestration reste
    // verrouillée au niveau des routes elles-mêmes (défense en profondeur).
    expect(classifyApiPath("/api/agents").access).toBe("user");
  });

  it("ne confond PAS /api/neural/public-stats (public) avec /api/neural (restreint)", () => {
    expect(classifyApiPath("/api/neural/public-stats").access).toBe("public");
    expect(classifyApiPath("/api/neural/public-stats-x").access).toBe("restreint");
  });

  it("ne confond PAS /api/video/worker (public) avec /api/video/projects (user studio)", () => {
    expect(classifyApiPath("/api/video/worker/tick").access).toBe("public");
    expect(classifyApiPath("/api/video/projects").access).toBe("user");
    expect(classifyApiPath("/api/video/projects").family).toBe("studio");
  });

  it("ne confond PAS /api/observability/overview (user) avec /api/observability/org (restreint)", () => {
    expect(classifyApiPath("/api/observability/overview").access).toBe("user");
    expect(classifyApiPath("/api/observability/org").access).toBe("restreint");
  });

  it("ignore la query string (classification par pathname)", () => {
    expect(classifyApiPath("/api/memory?limit=10").access).toBe("user");
  });
});

describe("Pages — PUBLICS", () => {
  const publics = [
    "/",
    "/login",
    "/signup",
    "/faq",
    "/privacy",
    "/en",
    "/monitoring",
    "/robots.txt",
    "/sitemap.xml",
    "/manifest.webmanifest",
    "/sw.js",
    "/offline.html",
    "/ads.txt",
    "/llms.txt",
    "/llms-full.txt",
    "/client/c/slug",
    "/client/agent-1",
    "/preview/artefact-1",
    "/icons/icon-192.png",
    "/images/hero.png",
    "/sdk/client.mjs",
    "/worklets/audio.worklet.js",
    "/gen3ia-logo.png",
    "/og-image.png",
  ];

  it.each(publics)("%s → public", (path) => {
    expect(classifyPagePath(path)).toMatchObject({ access: "public" });
  });
});

describe("Pages — LISTE BLANCHE UTILISATEUR", () => {
  const utilisateurs = [
    ["/chat", "chat"],
    ["/chat/", "chat"],
    ["/chat-v4", "chat"],
    ["/dashboard", "chat"],
    ["/workspace", "chat"],
    ["/workspace/conversations", "chat"],
    ["/workspace/conversations/c1", "chat"],
    ["/approvals/a1", "chat"],
    ["/workspace/training", "training"],
    ["/workspace/training/p1", "training"],
    ["/workspace/connectors", "connecteurs"],
    ["/studio/connections", "connecteurs"],
    ["/workspace/schedules", "planifications"],
    ["/billing", "facturation"],
    ["/settings", "parametres"],
    ["/workspace/knowledge", "connaissances"],
    ["/workspace/projects", "projets"],
    ["/workspace/projects/p1", "projets"],
    ["/workspace/files", "fichiers"],
    ["/workspace/bibliotheque", "fichiers"],
    ["/storage", "fichiers"],
    ["/memory", "memoire"],
    ["/observability", "observabilite"],
    ["/integrations", "integrations"],
    // STUDIO MÉTIER (réouverture propriétaire) — hub complet hors console
    ["/studio", "studio"],
    ["/studio/agents", "studio"],
    ["/studio/agents/", "studio"],
    ["/studio/video", "studio"],
    ["/studio/clients", "studio"],
    ["/studio/finance/cashflow", "studio"],
    ["/studio/create", "studio"],
    ["/studio/documents", "studio"],
    ["/studio/operations", "studio"],
    ["/studio/results", "studio"],
    ["/studio/sales", "studio"],
    ["/studio/compliance", "studio"],
    ["/studio/connections", "connecteurs"],
    // AGENT LIVE (réouverture propriétaire — PC et Android)
    ["/live", "live"],
  ] as const;

  it.each(utilisateurs)("%s → user (%s)", (path, family) => {
    expect(classifyPagePath(path)).toMatchObject({ access: "user", family });
  });
});

describe("Pages — RESTREINT (deny-by-default)", () => {
  const restreints = [
    "/admin",
    "/admin/users",
    "/admin/payouts",
    "/developer",
    "/developer/projects",
    "/arene",
    "/essaim",
    "/monde",
    "/neural",
    "/ondes",
    "/team",
    "/team/t1",
    "/team/join",
    // Studio métier : hub réouvert ; SEULE /studio/console reste
    // interdite (IDE développeur — clés API, projets, paiements dev)
    "/studio/console",
    "/studio/console/ide",
    // ⚠️ frontière critique : /settings oui, /settings/ads non (module ads)
    "/settings/ads",
    // Sous-pages workspace inconnues → deny
    "/workspace/inconnu",
    // Racines inconnues → deny
    "/inconnu",
    "/secret",
  ];

  it.each(restreints)("%s → restreint", (path) => {
    expect(classifyPagePath(path)).toMatchObject({ access: "restreint" });
  });

  it("/studio réouvert aux utilisateurs, /studio/console (IDE dev) reste restreint", () => {
    expect(classifyPagePath("/studio/connections").access).toBe("user");
    expect(classifyPagePath("/studio").access).toBe("user");
    expect(classifyPagePath("/studio/agents").access).toBe("user");
    expect(classifyPagePath("/studio/console").access).toBe("restreint");
    expect(classifyPagePath("/studio/console-x").access).toBe("user");
  });

  it("/settings exact est autorisé, /settings/ads est restreint", () => {
    expect(classifyPagePath("/settings").access).toBe("user");
    expect(classifyPagePath("/settings/ads").access).toBe("restreint");
  });
});

describe("isAdminActor — custom claim admin uniquement", () => {
  it("reconnaît admin: true", () => {
    expect(isAdminActor({ admin: true })).toBe(true);
    expect(isAdminActor({ admin: true, role: "x" })).toBe(true);
  });

  it("rejette tout le reste (y compris vérités fausses)", () => {
    expect(isAdminActor({ admin: "true" })).toBe(false);
    expect(isAdminActor({ admin: 1 })).toBe(false);
    expect(isAdminActor({ role: "admin" })).toBe(false);
    expect(isAdminActor({})).toBe(false);
    expect(isAdminActor(undefined)).toBe(false);
    expect(isAdminActor(null)).toBe(false);
  });
});

describe("createCachedAdminResolver — cache mémoire court", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("appelle le chargeur une seule fois dans la fenêtre TTL", async () => {
    const loadRole = vi.fn().mockResolvedValue(true);
    const resolver = createCachedAdminResolver(loadRole, { ttlMs: 60_000 });

    await expect(resolver("u1")).resolves.toBe(true);
    await expect(resolver("u1")).resolves.toBe(true);
    await expect(resolver("u1")).resolves.toBe(true);
    expect(loadRole).toHaveBeenCalledTimes(1);
  });

  it("expire après TTL et re-consulte l'annuaire", async () => {
    const loadRole = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const resolver = createCachedAdminResolver(loadRole, { ttlMs: 60_000 });

    await expect(resolver("u1")).resolves.toBe(true);
    vi.advanceTimersByTime(61_000);
    await expect(resolver("u1")).resolves.toBe(false);
    expect(loadRole).toHaveBeenCalledTimes(2);
  });

  it("ne met JAMAIS une erreur d'annuaire en cache (repli fail-closed à l'appelant)", async () => {
    const loadRole = vi.fn().mockRejectedValueOnce(new Error("annuaire indisponible")).mockResolvedValue(true);
    const resolver = createCachedAdminResolver(loadRole);

    await expect(resolver("u1")).rejects.toThrow("annuaire indisponible");
    await expect(resolver("u1")).resolves.toBe(true);
    expect(loadRole).toHaveBeenCalledTimes(2);
  });

  it("distingue les utilisateurs (clé par uid)", async () => {
    const loadRole = vi.fn().mockImplementation((uid: string) => Promise.resolve(uid === "admin-1"));
    const resolver = createCachedAdminResolver(loadRole);

    await expect(resolver("admin-1")).resolves.toBe(true);
    await expect(resolver("user-2")).resolves.toBe(false);
    expect(loadRole).toHaveBeenCalledTimes(2);
  });

  it("évince les entrées au-delà de maxEntries (FIFO)", async () => {
    const loadRole = vi.fn().mockResolvedValue(true);
    const resolver = createCachedAdminResolver(loadRole, { ttlMs: 60_000, maxEntries: 2 });

    await resolver("u1");
    await resolver("u2");
    await resolver("u3"); // évince u1
    await resolver("u1"); // re-consulté → 4e appel au total
    expect(loadRole).toHaveBeenCalledTimes(4);
  });
});
