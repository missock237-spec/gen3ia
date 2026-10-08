import { describe, expect, it } from "vitest";

import { detectToolIntents, formatToolIntentSection, type ToolIntentHint } from "./tool-intent";

/**
 * Task 107-c — AUTO-SÉLECTION DES OUTILS (détection déterministe).
 * Contrats verrouillés :
 *  1. detectToolIntents reconnaît les intentions à haute confiance (FR) et
 *     renvoie les outils GEN3IA_TOOLS candidats ordonnés par préférence ;
 *  2. aucune intention (« Bonjour ») → tableau vide, aucun bruit ;
 *  3. scan borné à 2000 caractères (troncature sans crash) ;
 *  4. regex linéaires anti-ReDoS (chaîne pathologique traitée vite) ;
 *  5. formatToolIntentSection : "" si vide, consigne d'outil UNIQUEMENT si
 *     l'outil est dans le catalogue effectif, mention d'indisponibilité sinon,
 *     et règle générale « c'est l'agent qui choisit l'outil » toujours présente.
 */
describe("detectToolIntents", () => {
  it("détecte une intention vidéo avec video.create en candidat principal", () => {
    const hints = detectToolIntents("crée-moi une vidéo TikTok de 30 secondes sur le café");
    expect(hints).toHaveLength(1);
    expect(hints[0].intent).toBe("video");
    expect(hints[0].toolNames).toEqual(["video.create"]);
    expect(hints[0].rationale.length).toBeGreaterThan(0);
  });

  it("détecte une intention image pour « dessine un logo »", () => {
    const hints = detectToolIntents("dessine un logo pour ma boulangerie");
    expect(hints.map((h) => h.intent)).toContain("image");
    const image = hints.find((h) => h.intent === "image");
    expect(image?.toolNames).toEqual(["image.generate"]);
  });

  it("détecte une intention email avec adresse énoncée", () => {
    const hints = detectToolIntents("envoie un email à contact@x.com avec le résumé");
    expect(hints.map((h) => h.intent)).toContain("email");
    const email = hints.find((h) => h.intent === "email");
    expect(email?.toolNames).toEqual(["email.send"]);
  });

  it("détecte une intention schedule pour une tâche récurrente", () => {
    const hints = detectToolIntents("planifie un post chaque lundi matin");
    expect(hints.map((h) => h.intent)).toContain("schedule");
    const schedule = hints.find((h) => h.intent === "schedule");
    expect(schedule?.toolNames).toEqual(["schedule.create"]);
  });

  it("détecte une intention web_research pour une recherche web", () => {
    const hints = detectToolIntents("cherche sur le web les concurrents de mon marché");
    expect(hints.map((h) => h.intent)).toContain("web_research");
    const research = hints.find((h) => h.intent === "web_research");
    expect(research?.toolNames).toEqual(["web.search", "web.open"]);
  });

  it("ne détecte RIEN sur une salutation sans besoin outillé", () => {
    expect(detectToolIntents("Bonjour")).toEqual([]);
  });

  it("ignore les questions méta sans impératif (pas de production forcée)", () => {
    expect(detectToolIntents("c'est quoi un bon montage vidéo ?").filter((h) => h.intent === "video")).toEqual([]);
    expect(detectToolIntents("comment créer un logo efficace ?").filter((h) => h.intent === "image")).toEqual([]);
  });

  it("tronque un objectif > 2000 caractères sans crash (intention hors fenêtre ignorée)", () => {
    const long = `${"remplissage ".repeat(400)}crée une vidéo`;
    expect(() => detectToolIntents(long)).not.toThrow();
    // « crée une vidéo » tombe AU-DELÀ de la fenêtre de 2000 chars → ignoré.
    expect(detectToolIntents(long)).toEqual([]);
  });

  it("détecte quand même l'intention placée DANS la fenêtre de 2000 chars", () => {
    const prefix = "intro inutile. ";
    const long = `${prefix.repeat(120)}crée une vidéo sur le café`;
    const hints = detectToolIntents(long);
    expect(hints.map((h) => h.intent)).toContain("video");
  });

  it("est ReDoS-safe sur des chaînes pathologiques (temps quasi-linéaire)", () => {
    const pathological = [
      "a".repeat(100_000),
      "((((((((((a".repeat(5_000),
      "@@@@@@@@@@".repeat(5_000),
      "https://" + "a".repeat(50_000),
    ];
    const start = performance.now();
    for (const sample of pathological) expect(detectToolIntents(sample)).toEqual([]);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("cumule plusieurs intentions distinctes et plafonne à 4 indices", () => {
    const cram = [
      "crée une vidéo sur le café",
      "dessine un logo",
      "envoie un email à a@b.com",
      "planifie un post chaque lundi",
      "cherche sur le web les concurrents",
    ].join(", ");
    const hints = detectToolIntents(cram);
    expect(hints).toHaveLength(4);
    expect(hints.map((h) => h.intent)).toEqual(["video", "image", "email", "schedule"]);
  });

  it("détecte les intentions complémentaires : social, API, knowledge, zip, voice, workflow", () => {
    expect(detectToolIntents("publie cette vidéo sur Instagram")[0]).toMatchObject({ intent: "publish_social", toolNames: ["social.publish"] });
    expect(detectToolIntents("appelle l'API https://api.exemple.com/v1/users")[0]).toMatchObject({ intent: "api_call" });
    expect(detectToolIntents("cherche dans mes documents les notes de réunion")[0]).toMatchObject({ intent: "knowledge", toolNames: ["knowledge.search"] });
    expect(detectToolIntents("compresse ces fichiers en zip")[0]).toMatchObject({ intent: "file_zip", toolNames: ["zip.create"] });
    expect(detectToolIntents("génère une voix off pour ma présentation")[0]).toMatchObject({ intent: "voice", toolNames: ["voice.speak", "voice.list"] });
    // « chaque semaine » déclenche aussi schedule (ordre de détection) :
    // on vérifie la PRÉSENCE de l'intention workflow, pas sa position.
    const workflowHints = detectToolIntents("automatise l'envoi du rapport chaque semaine");
    expect(workflowHints.map((h) => h.intent)).toContain("workflow");
    expect(workflowHints.find((h) => h.intent === "workflow")?.toolNames).toEqual(["workflow.create"]);
  });
});

describe("formatToolIntentSection", () => {
  const videoHint: ToolIntentHint = {
    intent: "video",
    toolNames: ["video.create"],
    rationale: "La production vidéo complète est lancée par video.create.",
  };

  it("renvoie une chaîne vide quand aucun indice", () => {
    expect(formatToolIntentSection([], ["video.create"])).toBe("");
  });

  it("produit une consigne d'outil explicite + la règle générale", () => {
    const section = formatToolIntentSection([videoHint], ["video.create", "web.search"]);
    expect(section).toContain("SÉLECTION AUTOMATIQUE DES OUTILS");
    expect(section).toContain('toolName="video.create"');
    expect(section).toContain("(input conforme au catalogue)");
    expect(section).toContain("l'utilisateur ne désigne JAMAIS l'outil");
    expect(section).toContain("Ne force un outil QUE si la demande l'appelle réellement");
  });

  it("choisit le PREMIER candidat disponible dans le catalogue effectif", () => {
    const apiHint: ToolIntentHint = {
      intent: "api_call",
      toolNames: ["custom_api.call", "web.api"],
      rationale: "Appel HTTP réel.",
    };
    const section = formatToolIntentSection([apiHint], ["web.api"]);
    expect(section).toContain('toolName="web.api"');
    expect(section).not.toContain('toolName="custom_api.call"');
  });

  it("mentionne l'indisponibilité SANS consigne d'outil quand l'outil est absent du catalogue", () => {
    const section = formatToolIntentSection([videoHint], ["web.search"]);
    expect(section).toContain("INDISPONIBLE");
    expect(section).not.toContain("privilégie une étape");
    expect(section).not.toContain('toolName="');
    expect(section).not.toContain("video.create");
  });

  it("utilise le libellé FR lisible de l'intention", () => {
    const section = formatToolIntentSection([videoHint], ["video.create"]);
    expect(section).toContain("création d'une vidéo");
  });
});
