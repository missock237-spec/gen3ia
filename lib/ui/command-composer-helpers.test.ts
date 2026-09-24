import { describe, expect, it } from "vitest";

import {
  detectCommandQuery,
  detectMentionQuery,
  filterCommands,
  filterMentions,
  moveHighlight,
  stripTrigger,
  type ComposerCommand,
} from "./command-composer-helpers";

describe("detectMentionQuery", () => {
  it("détecte @ en fin de saisie avec sa requête", () => {
    expect(detectMentionQuery("Bonjour @git")).toBe("git");
    expect(detectMentionQuery("@")).toBe("");
    expect(detectMentionQuery("analyse @github_")).toBe("github_");
  });

  it("ignore @ au milieu d'un mot ou dans une URL", () => {
    expect(detectMentionQuery("contact@example.com")).toBeNull();
    expect(detectMentionQuery("écrit à @jean stp")).toBeNull();
    expect(detectMentionQuery("sans mention")).toBeNull();
  });

  it("détecte @ après un espace ou en début de texte", () => {
    expect(detectMentionQuery("publication @linkedin")).toBe("linkedin");
    expect(detectMentionQuery("@notion cherche mes notes")).toBeNull(); // pas en fin
  });
});

describe("detectCommandQuery", () => {
  it("détecte / en fin de saisie", () => {
    expect(detectCommandQuery("/")).toBe("");
    expect(detectCommandQuery("/hist")).toBe("hist");
    expect(detectCommandQuery("effacer /nouvelle")).toBe("nouvelle");
  });

  it("ignore / au milieu d'un chemin déjà saisi", () => {
    expect(detectCommandQuery("https://example.com")).toBeNull();
    expect(detectCommandQuery("lire docs/readme")).toBeNull();
  });
});

describe("filterCommands", () => {
  const commands: ComposerCommand[] = [
    { id: "nouvelle", label: "Nouvelle conversation", run: () => undefined },
    { id: "historique", label: "Historique", description: "Conversations passées", run: () => undefined },
    { id: "fichier", label: "Joindre un fichier", run: () => undefined },
  ];

  it("renvoie tout sans requête", () => {
    expect(filterCommands(commands, "")).toHaveLength(3);
    expect(filterCommands(commands, "   ")).toHaveLength(3);
  });

  it("filtre par label, id et description (insensible à la casse)", () => {
    expect(filterCommands(commands, "hist").map((item) => item.id)).toEqual(["historique"]);
    expect(filterCommands(commands, "FICHIER").map((item) => item.id)).toEqual(["fichier"]);
    // « conversation » matche le label « Nouvelle conversation » ET la
    // description de l'historique (« Conversations passées »).
    expect(filterCommands(commands, "conversation").map((item) => item.id)).toEqual(["nouvelle", "historique"]);
    expect(filterCommands(commands, "inconnu")).toHaveLength(0);
  });
});

describe("filterMentions", () => {
  const items = [
    { toolkit: "github", label: "GitHub", description: "Dépôts et pull requests" },
    { toolkit: "notion", label: "Notion", description: "Notes et documents" },
  ];

  it("filtre les connecteurs par label et toolkit", () => {
    expect(filterMentions(items, "git")).toHaveLength(1);
    expect(filterMentions(items, "NOTION")).toHaveLength(1);
    expect(filterMentions(items, "")).toHaveLength(2);
    expect(filterMentions(items, "slack")).toHaveLength(0);
  });
});

describe("stripTrigger", () => {
  it("retire le déclencheur @ de fin de texte", () => {
    expect(stripTrigger("analyse @git", "@")).toBe("analyse");
    expect(stripTrigger("email@test.com", "@")).toBe("email@test.com"); // pas en fin seule
  });

  it("retire le déclencheur / de fin de texte", () => {
    expect(stripTrigger("/historique", "/")).toBe("");
    expect(stripTrigger("fais /hist", "/")).toBe("fais");
  });
});

describe("moveHighlight", () => {
  it("navigue avec bouclage et gère les listes vides", () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(1, 1, 0)).toBe(-1);
  });
});
