import { describe, expect, it } from "vitest";

import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import {
  buildToolReport,
  hardenAuthorizationMode,
  normalizeToolName,
  resolveAndHarden,
  resolveDeclaredTools,
} from "./tool-resolver";

/**
 * Étape 7 du plan 20 — reconnaissance des outils « en clair » proposés par
 * Agent gen + durcissement automatique. Contrats verrouillés :
 *  1. un nom canonique du registre reste inchangé (kept) ;
 *  2. un alias métier en clair est traduit vers le vrai outil (mapped) ;
 *  3. une entrée inconnue est RETIRÉE avec raison (jamais persistée) ;
 *  4. la normalisation tolère casse, accents, ponctuation ;
 *  5. auto_allow + outil sensible → ask_if_needed (durcissement) ;
 *  6. read-only + auto_allow → aucun durcissement ;
 *  7. le rapport condensé reflète la résolution ;
 *  8. tout outil résolu appartient RÉELLEMENT au registre.
 */
describe("normalizeToolName", () => {
  it("minuscule, retire les accents et remplace la ponctuation par des espaces", () => {
    expect(normalizeToolName("Gmail — Envoi d'Émaïls")).toBe("gmail envoi d emails");
    expect(normalizeToolName("  Recherche_Web.FR  ")).toBe("recherche web fr");
  });
});

describe("resolveDeclaredTools", () => {
  it("garde tel quel un nom canonique du registre", () => {
    const { resolved, mapping } = resolveDeclaredTools(["web.search", "email.send"]);
    expect(resolved).toEqual(["web.search", "email.send"]);
    expect(mapping.every((entry) => entry.status === "kept")).toBe(true);
  });

  it("garde un nom canonique mal orthographié en casse (Web.Search)", () => {
    const { resolved, mapping } = resolveDeclaredTools(["Web.Search"]);
    expect(resolved).toEqual(["web.search"]);
    expect(mapping[0]?.status).toBe("kept");
  });

  it("mappe les alias métier vers les vrais outils (gmail, recherche, code, documents…)", () => {
    const { resolved, mapping } = resolveDeclaredTools([
      "Gmail",
      "recherche web",
      "exécuter du Python",
      "générer un PDF",
      "envoyer des WhatsApp",
    ]);
    expect(resolved).toContain("email.send");
    expect(resolved).toContain("web.search");
    expect(resolved).toContain("code.execute");
    expect(resolved).toContain("artifact.create");
    expect(resolved).toContain("messaging.send");
    const mappedStatuses = new Set(mapping.map((entry) => entry.status));
    expect(mappedStatuses.has("mapped")).toBe(true);
    expect(mapping.find((entry) => entry.from === "Gmail")?.to).toBe("email.send");
  });

  it("retire explicitement les outils inconnus avec une raison actionnable", () => {
    const { resolved, unknown, mapping } = resolveDeclaredTools(["jira", "trello", "outil magique"]);
    expect(resolved).toEqual([]);
    expect(unknown).toEqual(["jira", "trello", "outil magique"]);
    expect(mapping.filter((entry) => entry.status === "removed")).toHaveLength(3);
    expect(mapping.find((entry) => entry.from === "jira")?.reason).toMatch(/MCP|Composio/i);
    expect(mapping.find((entry) => entry.from === "outil magique")?.reason).toMatch(/inconnu/i);
  });

  it("déduplique après résolution (Gmail + email.send → un seul email.send)", () => {
    const { resolved } = resolveDeclaredTools(["Gmail", "email.send", "envoi d'emails"]);
    expect(resolved.filter((tool) => tool === "email.send")).toHaveLength(1);
  });

  it("ne produit JAMAIS un outil hors registre, quel que soit l'entrée", () => {
    const registry = new Set(GEN3IA_TOOLS.map((tool) => tool.name));
    const { resolved } = resolveDeclaredTools([
      "Gmail", "Jira", "Slack", "recherche Google", "terminal bash", "voix", "photo",
      "webhook", "Notion", "GitHub", "Cloudflare DNS", "API personnelle", "Zapier",
      "mémoire", "connaissance", "archive zip", "agenda", "publicité", "LinkedIn",
    ]);
    for (const tool of resolved) expect(registry.has(tool)).toBe(true);
  });

  it("gère une liste vide et déduplique les doublons déclarés", () => {
    expect(resolveDeclaredTools([]).resolved).toEqual([]);
    expect(resolveDeclaredTools(["web.search", "web.search"]).resolved).toEqual(["web.search"]);
  });

  it("garde les sous-services internes (schedule.*, workflow.*) qui ont une définition de sécurité réelle", () => {
    const { resolved, mapping } = resolveDeclaredTools(["schedule.create", "workflow.run"]);
    expect(resolved).toEqual(["schedule.create", "workflow.run"]);
    expect(mapping.every((entry) => entry.status === "kept")).toBe(true);
  });

  it("mappe « tâches planifiées » / « récurrent » vers schedule.create", () => {
    const { resolved } = resolveDeclaredTools(["tâches planifiées chaque lundi", "envoi récurrent"]);
    expect(resolved).toContain("schedule.create");
  });
});

describe("hardenAuthorizationMode", () => {
  it("rétrograde auto_allow → ask_if_needed dès qu'un outil sensible est présent", () => {
    const result = hardenAuthorizationMode(["email.send", "web.search"], "auto_allow");
    expect(result.hardened).toBe(true);
    expect(result.mode).toBe("ask_if_needed");
    expect(result.sensitiveTools).toEqual(["email.send"]);
  });

  it("ne durcit PLUS les outils médias (internes, directive 10-10)", () => {
    // image.generate / video.create sont désormais « write » : la génération
    // n'est plus une action sensible — auto_allow reste auto_allow.
    const result = hardenAuthorizationMode(["image.generate", "video.create"], "auto_allow");
    expect(result.hardened).toBe(false);
    expect(result.mode).toBe("auto_allow");
    expect(result.sensitiveTools).toEqual([]);
  });

  it("traite destructive comme sensible (terminal.execute, code.execute)", () => {
    const result = hardenAuthorizationMode(["terminal.execute"], "auto_allow");
    expect(result.hardened).toBe(true);
    expect(result.sensitiveTools).toEqual(["terminal.execute"]);
  });

  it("ne durcit PAS une config read-only en auto_allow (outils de lecture)", () => {
    const result = hardenAuthorizationMode(["web.search", "knowledge.search", "memory.read"], "auto_allow");
    expect(result.hardened).toBe(false);
    expect(result.mode).toBe("auto_allow");
    expect(result.sensitiveTools).toEqual([]);
  });

  it("ne touche jamais aux modes always_ask / ask_if_needed", () => {
    for (const mode of ["always_ask", "ask_if_needed"] as const) {
      const result = hardenAuthorizationMode(["email.send", "phone.call"], mode);
      expect(result.mode).toBe(mode);
      expect(result.hardened).toBe(false);
      expect(result.sensitiveTools.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAndHarden + buildToolReport", () => {
  it("produit un rapport complet : mappés, retirés, sensibles, durcissement", () => {
    const { resolution, hardening, report } = resolveAndHarden(
      ["Gmail", "recherche web", "Jira", "phone.call"],
      "auto_allow",
    );
    expect(resolution.resolved).toEqual(expect.arrayContaining(["email.send", "web.search", "phone.call"]));
    expect(hardening.mode).toBe("ask_if_needed");
    expect(report.mapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "Gmail", to: "email.send" }),
    ]));
    expect(report.removed).toEqual([expect.objectContaining({ from: "Jira" })]);
    expect(report.sensitiveTools).toEqual(expect.arrayContaining(["email.send", "phone.call"]));
    expect(report.hardened).toBe(true);
    expect(report.tools).toEqual(resolution.resolved);
  });

  it("rapport neutre quand rien ne change", () => {
    const { report } = resolveAndHarden(["web.search"], "always_ask");
    expect(report.mapped).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.hardened).toBe(false);
  });

  it("buildToolReport reste cohérent avec la résolution fournie", () => {
    const resolution = resolveDeclaredTools(["Gmail", "inconnu-total"]);
    const hardening = hardenAuthorizationMode(resolution.resolved, "always_ask");
    const report = buildToolReport(resolution, hardening);
    expect(report.tools).toEqual(resolution.resolved);
    expect(report.removed).toEqual([expect.objectContaining({ from: "inconnu-total" })]);
  });
});

describe("alias médias (image.generate / video.create) — audit outils médias", () => {
  it("mappe image/photo/dessin/logo/bannière/illustration vers image.generate", () => {
    const { resolved, mapping } = resolveDeclaredTools([
      "Génération d'images",
      "photo",
      "dessins",
      "logo pour ma marque",
      "bannière",
      "illustrations",
    ]);
    expect(resolved).toEqual(["image.generate"]);
    expect(mapping.every((entry) => entry.status === "mapped")).toBe(true);
    expect(mapping.find((entry) => entry.from === "photo")?.to).toBe("image.generate");
  });

  it("mappe vidéo/clip/shorts/montage vidéo/reels-de-plateforme vers video.create", () => {
    const { resolved } = resolveDeclaredTools([
      "vidéo youtube",
      "clips",
      "shorts",
      "montage vidéo",
      "reels instagram",
      "tiktok reels",
    ]);
    expect(resolved).toEqual(["video.create"]);
  });

  it("ne mappe PAS les homographes : « réels » (reel(s) après normalisation) et « short » adjectif restent hors médias", () => {
    const { resolved, unknown } = resolveDeclaredTools(["données réelles", "short link"]);
    expect(resolved).toEqual([]);
    expect(unknown).toEqual(["données réelles", "short link"]);
  });

  it("« photo » passe désormais à image.generate tandis que camera/capture reste camera.capture", () => {
    const { resolved } = resolveDeclaredTools(["capture d'écran", "photos générées", "camera"]);
    expect(resolved).toContain("camera.capture");
    expect(resolved).toContain("image.generate");
    expect(resolved).not.toContain("photo"); // jamais un nom hors registre
  });

  it("les outils médias INTERNES ne déclenchent plus le durcissement (directive 10-10)", () => {
    const { resolution, hardening } = resolveAndHarden(["générer une image", "montage vidéo"], "auto_allow");
    expect(resolution.resolved).toEqual(["image.generate", "video.create"]);
    // Génération = outil interne (risque write) : auto_allow reste auto_allow,
    // aucune rétrogradation — la génération n'est jamais gated par le HITL.
    expect(hardening.hardened).toBe(false);
    expect(hardening.mode).toBe("auto_allow");
    expect(hardening.sensitiveTools).toEqual([]);
  });
});
