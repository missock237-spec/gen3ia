import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Gardes structurels — provider « huggingface » supprimé (audit médias 103-c).
 *
 * Le provider n'a JAMAIS eu d'adaptateur texte (lib/ai/providers/index.ts
 * levait « implemented separately »), aucun chemin de production ne le
 * référence et ses entrées de coût (COST_HF_*) ne servaient à rien. Ces
 * gardes verrouillent la suppression : toute réintroduction doit être un
 * choix explicite avec adaptateur réel, pas une résurrection fantôme.
 */

describe("lib/ai — provider huggingface supprimé (audit médias 103-c)", () => {
  const modelsSource = readFileSync(path.join(import.meta.dirname, "models.ts"), "utf8");
  const providersIndexSource = readFileSync(
    path.join(import.meta.dirname, "providers", "index.ts"),
    "utf8",
  );
  const costEngineSource = readFileSync(
    path.join(import.meta.dirname, "..", "billing", "cost-engine.ts"),
    "utf8",
  );

  it("garde : models.ts ne déclare plus « huggingface » dans l'union AIProvider", () => {
    // Forme syntaxique de l'union : le libellé peut rester cité dans les
    // commentaires FR (historique), mais plus AUCUN membre d'union.
    expect(modelsSource).not.toContain('| "huggingface"');
    expect(modelsSource).not.toContain('"huggingface"');
    // L'union conserve les six fournisseurs réellement implémentés.
    for (const provider of ["groq", "openrouter", "anthropic", "openai", "glm", "agnes"]) {
      expect(modelsSource).toContain(`"${provider}"`);
    }
  });

  it("garde : providers/index.ts ne référence plus l'adaptateur HF jamais implémenté", () => {
    expect(providersIndexSource).not.toContain('case "huggingface"');
    expect(providersIndexSource).not.toContain("implemented separately");
  });

  it("garde : cost-engine.ts ne tarife plus le provider mort (COST_HF_* retirés)", () => {
    expect(costEngineSource).not.toContain("huggingface:");
    // Lecture effective de la variable de coût : plus AUCUN process.env.COST_HF.
    expect(costEngineSource).not.toContain("process.env.COST_HF");
  });

  it("garde : le schéma d'entrée utilisateur du chat n'accepte plus « huggingface »", () => {
    // app/api/chat/message/route.ts — zod d'ENTRÉE aligné sur l'union
    // AIProvider (audit médias 103-c) : la valeur est rejetée à la validation.
    const routeSource = readFileSync(
      path.join(import.meta.dirname, "..", "..", "app", "api", "chat", "message", "route.ts"),
      "utf8",
    );
    expect(routeSource).not.toContain('"huggingface"');
    expect(routeSource).toContain('provider: z.enum(["groq","openrouter","anthropic","openai","glm","agnes"])');
  });
});
