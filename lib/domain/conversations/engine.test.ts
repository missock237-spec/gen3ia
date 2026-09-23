import { describe, expect, it } from "vitest";

import {
  buildIntentSystemPrompt,
  condenseToolOutput,
  conversationToolCatalog,
  dataScopeForTool,
  estimatedCostForTool,
  inferArtifactType,
  stepRequiresApproval,
} from "./engine";
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
