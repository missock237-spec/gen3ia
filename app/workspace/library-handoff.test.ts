import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 14 du plan 20 — bibliothèque de capacités : sélectionner un projet,
 * choisir une capacité → la conversation s'ouvre DIRECTEMENT et commence à
 * travailler en rendu streaming (timeline, ETA, validations), au lieu
 * d'attendre la fin du tour complet sur la page de la bibliothèque.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Bibliothèque → conversation directe en streaming", () => {
  it("la bibliothèque transmet le prompt via le marqueur de hand-off partagé", () => {
    const page = read("app/workspace/bibliotheque/page.tsx");
    expect(page).toContain("PENDING_MESSAGE_PREFIX");
    expect(page).toContain("starterPrompt");
    expect(page).toContain('router.push(`/workspace/conversations/${data.conversation.id}`)');
  });

  it("la bibliothèque n'attend PLUS la fin du tour avant de naviguer (POST /messages supprimé)", () => {
    const page = read("app/workspace/bibliotheque/page.tsx");
    expect(page).not.toContain("/messages`");
    expect(page).not.toContain("/messages\"");
  });

  it("le marqueur est le MÊME des deux côtés (constante exportée, zéro dérive)", () => {
    const workspace = read("components/workspace/conversation-workspace.tsx");
    expect(workspace).toContain('export const PENDING_MESSAGE_PREFIX = "g3-pending-message:";');
  });

  it("le consommateur envoie bien le message en rendu en direct (sendMessage)", () => {
    const workspace = read("components/workspace/conversation-workspace.tsx");
    const start = workspace.indexOf("const raw = sessionStorage.getItem(key)");
    expect(start).toBeGreaterThan(0);
    const section = workspace.slice(start, start + 500);
    expect(section).toContain("sendMessage");
    expect(section).toContain("sessionStorage.removeItem(key)");
  });
});
