import { describe, expect, it } from "vitest";

import {
  buildIntentSystemPrompt,
  condenseToolOutput,
  conversationToolCatalog,
  dataScopeForTool,
  detectExplicitToolIntent,
  estimatedCostForTool,
  extractSearchQuery,
  inferArtifactType,
  stepRequiresApproval,
} from "./engine";
import { silentEmitter, safeEmitter } from "./stream-events";
import type { ConversationStreamEvent, StreamEventEmitter } from "./stream-events";
import { deriveRunStatus, makeStep } from "../runs/repository";
import { ARTIFACT_TYPES, isArtifactType } from "../artifacts/repository";
import type { RunStep } from "./types";

/**
 * Garde-fous du moteur conversationnel (Conversation-first) :
 * contrôle humain, lisibilité de la timeline et standardisation des
 * artefacts — sans dépendre de Firestore ni d'un provider IA.
 */

describe("moteur conversationnel — contrôle humain des actions sensibles", () => {
  it("exige une approbation pour les risques high et critical", () => {
    expect(stepRequiresApproval("high")).toBe(true);
    expect(stepRequiresApproval("critical")).toBe(true);
  });

  it("exécute sans approbation les risques faibles et moyens", () => {
    expect(stepRequiresApproval("low")).toBe(false);
    expect(stepRequiresApproval("medium")).toBe(false);
  });

  it("marque les outils externes sensibles comme « validation requise » dans le catalogue", () => {
    const catalog = conversationToolCatalog();
    expect(catalog.length).toBeGreaterThan(5);
    const byName = new Map(catalog.map((t) => [t.name, t]));
    // Lecture : pas de validation.
    expect(byName.get("web.search")?.requiresApproval).toBe(false);
    // Appel téléphonique (toujours enregistré, risque élevé) : validation obligatoire.
    expect(byName.get("phone.call")?.requiresApproval).toBe(true);
    // Caméra et code arbitraire exclus du périmètre conversationnel.
    expect(byName.has("camera.capture")).toBe(false);
    expect(byName.has("code.execute")).toBe(false);
  });

  it("produit un résumé d'impact et un périmètre de données lisibles", () => {
    expect(estimatedCostForTool("web.search")).toBe("gratuit");
    expect(estimatedCostForTool("phone.call")).toContain("0,02");
    expect(dataScopeForTool("composio.execute", { toolkit: "gmail" })).toContain("gmail");
    expect(dataScopeForTool("email.send")).toContain("Destinataire");
    expect(dataScopeForTool("social.publish")).toContain("public");
  });

  it("présente les outils et instructions de projet dans le prompt système d'intention", () => {
    const prompt = buildIntentSystemPrompt(
      [{ name: "web.search", description: "Search the public web.", risk: "low", requiresApproval: false }],
      {
        id: "p1",
        userId: "u1",
        name: "Lancement produit",
        authorizedConnectors: ["gmail"],
        status: "active",
        instructions: "Ton professionnel.",
        privacyRules: "Ne jamais citer de données clients.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );
    expect(prompt).toContain("web.search");
    expect(prompt).toContain("validation requise");
    expect(prompt).toContain("Lancement produit");
    expect(prompt).toContain("Ne jamais citer de données clients.");
  });

  it("injecte les connecteurs activés dans le prompt d'intention (composer)", () => {
    const withConnectors = buildIntentSystemPrompt(
      [
        { name: "web.search", description: "Recherche web.", risk: "low", requiresApproval: false },
        { name: "composio.execute", description: "Application connectée.", risk: "high", requiresApproval: true },
      ],
      null,
      ["gmail", "notion"],
    );
    expect(withConnectors).toContain("Connecteurs activés explicitement");
    expect(withConnectors).toContain("gmail, notion");
    expect(withConnectors).toContain("composio.execute");
    // Sans connecteurs : aucune section (ne pollue pas la décision).
    const without = buildIntentSystemPrompt(
      [{ name: "web.search", description: "Recherche web.", risk: "low", requiresApproval: false }],
    );
    expect(without).not.toContain("Connecteurs activés explicitement");
  });
});

describe("moteur conversationnel — événements de flux (streaming)", () => {
  const collect = (): { events: ConversationStreamEvent[]; emitter: StreamEventEmitter } => {
    const events: ConversationStreamEvent[] = [];
    return { events, emitter: (event) => void events.push(event) };
  };

  it("l'émetteur silencieux ne produit rien et ne lève jamais", async () => {
    expect(() => silentEmitter({ type: "status", phase: "plan", label: "test" })).not.toThrow();
    await Promise.resolve(silentEmitter({ type: "status", phase: "plan", label: "test" }));
  });

  it("safeEmitter avale les erreurs d'émission (client déconnecté) sans interrompre le tour", async () => {
    const crashing: StreamEventEmitter = () => {
      throw new Error("socket hang up");
    };
    const safe = safeEmitter(crashing);
    await expect(safe({ type: "status", phase: "plan", label: "avant crash" })).resolves.toBeUndefined();
  });

  it("safeEmitter tolère une promesse rejetée par l'émetteur", async () => {
    const rejecting: StreamEventEmitter = () => Promise.reject(new Error("write after end"));
    const safe = safeEmitter(rejecting);
    await expect(safe({ type: "message_delta", delta: "coucou" })).resolves.toBeUndefined();
  });

  it("safeEmitter sans émetteur se comporte comme l'émetteur silencieux", async () => {
    const safe = safeEmitter(undefined);
    expect(() => safe({ type: "error", message: "n'importe quoi" })).not.toThrow();
    await Promise.resolve(safe({ type: "error", message: "n'importe quoi" }));
  });

  it("les événements de flux couvrent le cycle complet d'un tour", () => {
    const { events, emitter } = collect();
    emitter({ type: "status", phase: "intention", label: "Analyse…" });
    emitter({ type: "turn_started", conversationId: "c1", userMessage: { id: "m1", conversationId: "c1", userId: "u1", role: "user", content: "bonjour", createdAt: new Date().toISOString() } });
    emitter({ type: "run_created", run: { id: "r1", userId: "u1", conversationId: "c1", objective: "o", status: "running", steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    emitter({ type: "message_delta", delta: "Réponse " });
    emitter({ type: "message_delta", delta: "en direct" });
    emitter({ type: "message_complete", message: { id: "m2", conversationId: "c1", userId: "u1", role: "assistant", content: "Réponse en direct", createdAt: new Date().toISOString() } });
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "turn_started",
      "run_created",
      "message_delta",
      "message_delta",
      "message_complete",
    ]);
  });
});

describe("moteur conversationnel — lisibilité de la timeline", () => {
  it("condense les sorties longues avec une mention explicite de troncature", () => {
    const long = "x".repeat(3000);
    const condensed = condenseToolOutput(long);
    expect(condensed.length).toBeLessThan(1300);
    expect(condensed).toContain("tronquée");
  });

  it("sérialise les objets complexes de façon lisible", () => {
    const condensed = condenseToolOutput({ ok: true, items: [1, 2] });
    expect(condensed).toContain("ok");
    expect(condensed).toContain("items");
  });

  it("dérive le statut du run depuis ses étapes", () => {
    const step = (status: RunStep["status"]): RunStep =>
      makeStep({ phase: "execution", title: "Étape", status });
    expect(deriveRunStatus([step("done"), step("awaiting")])).toBe("awaiting_approval");
    expect(deriveRunStatus([step("done"), step("in_progress")])).toBe("running");
    expect(deriveRunStatus([step("done"), step("failed")])).toBe("failed");
    expect(deriveRunStatus([step("done"), step("done")])).toBe("completed");
  });
});

describe("moteur conversationnel — garde-fou d'intention explicite", () => {
  const catalog = conversationToolCatalog();

  it("détecte une demande explicite de recherche web", () => {
    expect(detectExplicitToolIntent("Fais une recherche web sur les tendances IA", catalog)?.toolName).toBe("web.search");
    expect(detectExplicitToolIntent("cherche sur internet les prix concurrents", catalog)?.toolName).toBe("web.search");
    expect(detectExplicitToolIntent("Search the web for AI news", catalog)?.toolName).toBe("web.search");
  });

  it("ne déclenche pas le garde-fou pour une simple question", () => {
    expect(detectExplicitToolIntent("Bonjour, comment vas-tu ?", catalog)).toBeNull();
    expect(detectExplicitToolIntent("Rédige un e-mail de relance pour un client", catalog)).toBeNull();
  });

  it("extrait une requête de recherche nettoyée", () => {
    expect(extractSearchQuery("Fais une recherche web sur les tendances IA en Afrique et résume-moi les trois points clés")).toContain("tendances IA");
    expect(extractSearchQuery("cherche sur internet voitures électriques")).toContain("voitures électriques");
    // Toujours une requête non vide, même après nettoyage agressif.
    expect(extractSearchQuery("recherche web").length).toBeGreaterThan(0);
  });

  it("route une recherche d'information ACTUELLE sans mention « web » (audit 25-a)", () => {
    // Reproduction exacte de l'audit : réponse sans sources avant correctif.
    const intent = detectExplicitToolIntent("Recherche les dernières tendances de mon marché et fais un compte rendu", catalog);
    expect(intent?.toolName).toBe("web.search");
    expect(detectExplicitToolIntent("Compare les prix des smartphones pliables", catalog)?.toolName).toBe("web.search");
    expect(detectExplicitToolIntent("Informe-moi sur la réglementation IA en Europe", catalog)?.toolName).toBe("web.search");
  });

  it("route une demande explicite de livrable document vers artifact.create (audit 25-d)", () => {
    const pdf = detectExplicitToolIntent("Crée un PDF \"Rapport T4\" avec les chiffres du trimestre", catalog);
    expect(pdf?.toolName).toBe("artifact.create");
    if (pdf?.toolName === "artifact.create") {
      expect(pdf.document.format).toBe("pdf");
      expect(pdf.document.title.toLowerCase()).toContain("rapport");
    }
    expect(detectExplicitToolIntent("Prépare un rapport de suivi avec les prochaines échéances", catalog)?.toolName).toBe("artifact.create");
    const slides = detectExplicitToolIntent("Génère une présentation PowerPoint de lancement produit", catalog);
    if (slides?.toolName === "artifact.create") expect(slides.document.format).toBe("pptx");
    expect(detectExplicitToolIntent("Fais un tableau Excel des ventes", catalog)?.toolName).toBe("artifact.create");
  });

  it("force un livrable quand un rapport est demandé, même avec des données internes", () => {
    // Choix produit (audit 25-d) : « rédige un compte rendu » produit un
    // VRAI livrable — avant, l'« analyse » était fabriquée de mémoire dans
    // une simple réponse, sans données réelles ni fichier.
    expect(detectExplicitToolIntent("Analyse mes ventes du mois et rédige un compte rendu", catalog)?.toolName).toBe("artifact.create");
    expect(detectExplicitToolIntent("Quel est le ton officiel de notre marque ?", catalog)).toBeNull();
  });
});

describe("moteur conversationnel — artefacts standardisés", () => {
  it("couvre les six types d'artefacts", () => {
    expect(ARTIFACT_TYPES).toEqual(["code", "document", "table", "image", "report", "file"]);
    expect(isArtifactType("code")).toBe(true);
    expect(isArtifactType("podcast")).toBe(false);
  });

  it("infère le type d'artefact depuis la sortie de l'outil", () => {
    expect(inferArtifactType("artifact.create", "Rapport de ventes\n\nChiffres et analyses")).toBe("document");
    expect(inferArtifactType("file.create", "const app = () => 'hello'")).toBe("code");
    expect(inferArtifactType("artifact.create", { url: "https://cdn.example.com/img.png" })).toBe("image");
    expect(inferArtifactType("zip.create", { key: "users/u1/permanent/a.zip" })).toBe("file");
  });
});
