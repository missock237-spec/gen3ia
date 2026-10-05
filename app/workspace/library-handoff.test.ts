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

describe("Lot C2 (Task 101-c) — sondage léger du suivi de run (quota Firestore)", () => {
  const workspace = read("components/workspace/conversation-workspace.tsx");

  it("le poll 4 s passe par le GET léger ?meta=1 (jamais le détail complet)", () => {
    expect(workspace).toContain('fetch(`/api/workspace/conversations/${conversationId}?meta=1`');
    // Le GET complet reste réservé aux rechargements déclenchés (ouverture,
    // fin de tour, reprise hors-ligne) — plus aucun appel périodique.
    expect(workspace).toContain("await loadDetail(conversationId, true)");
  });

  it("à l'état terminal, le rechargement COMPLET n'arrive qu'une fois (garde par réf)", () => {
    expect(workspace).toContain("const runEndReloadRef = useRef(false);");
    expect(workspace).toContain("if (!conversationId || runEndReloadRef.current) return;");
    expect(workspace).toContain("runEndReloadRef.current = true;");
    // Réarmement à l'ouverture d'un nouvel épisode (run en cours dans le détail).
    expect(workspace).toContain('runEndReloadRef.current = data.runs?.[0]?.status === "running" ? false : runEndReloadRef.current;');
  });

  it("les invariants historiques du sondage sont conservés (visibilité + arrêt terminal)", () => {
    // Pause onglet caché : le pilotage reste confié à useVisiblePolling.
    expect(workspace).toContain("detail?.runs?.[0]?.status === \"running\" && conversationId ? 4_000 : null");
    expect(workspace).toContain("useVisiblePolling(");
  });
});
