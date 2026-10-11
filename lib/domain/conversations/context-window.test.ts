import { describe, expect, it } from "vitest";

import {
  COMPACT_CONTENT_CHARS,
  SUMMARY_MAX_TOKENS,
  buildContextWindow,
  compressMessage,
  estimateTokens,
  type ChatMessage,
} from "./context-window";

/**
 * Fenêtre glissante de contexte (Task 131) — contrat pur, sans E/S :
 * budget respecté, ordre chronologique préservé, prompt système jamais
 * sacrifié, premier message utilisateur conservé quand possible, résumé
 * déterministe des évacués (payloads d'outils tronqués en priorité).
 */

function message(index: number, role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${index}`,
    conversationId: "conv-1",
    userId: "u1",
    role,
    content,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ...extra,
  };
}

/** Historique réaliste : ouverture utilisateur, échanges moyens, récent. */
function historique(taille: number, tailleContenu = 600): ChatMessage[] {
  return Array.from({ length: taille }, (_, i) =>
    message(i, i % 2 === 0 ? "user" : "assistant", `Message numéro ${i} — ${"contenu ".repeat(Math.ceil(tailleContenu / 9))}`),
  );
}

const SYSTEME = [
  "Tu es Gen IA, l'agent IA universel de Gen3ia.",
  "Réponds de façon directe, structurée et actionnable.",
  "Ne prétends jamais avoir généré un média non affiché.",
].join("\n");

describe("estimateTokens — heuristique déterministe", () => {
  it("est nulle pour un texte vide et strictement croissante sinon", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
    expect(estimateTokens("a".repeat(100))).toBeLessThan(estimateTokens("a".repeat(200)));
  });

  it("majore avec la ponctuation (chaque signe ≈ ½ token)", () => {
    const plat = "mot simple sans ponctuation";
    const ponctue = "m, o; t! s? i... m: p(t)l[è]!";
    expect(estimateTokens(ponctue)).toBeGreaterThan(estimateTokens(plat));
  });

  it("est déterministe : même texte, même résultat", () => {
    const texte = "Bonjour ! Comment allez-vous ? Très bien, merci.";
    expect(estimateTokens(texte)).toBe(estimateTokens(texte));
  });
});

describe("compressMessage — ligne de résumé déterministe", () => {
  it("garde le rôle et les 240 premiers caractères, pas plus", () => {
    const long = `${"a".repeat(500)}LA-FIN-NE-DOIT-PAS-PASSER`;
    const ligne = compressMessage(message(0, "user", long));
    expect(ligne).toContain("[utilisateur]");
    expect(ligne).toContain(long.slice(0, COMPACT_CONTENT_CHARS));
    expect(ligne).not.toContain("LA-FIN-NE-DOIT-PAS-PASSER");
    expect(ligne.length).toBeLessThan(COMPACT_CONTENT_CHARS + 60);
  });

  it("liste les noms d'outils appelés (citations, dédupliquées) et le marqueur de résultat", () => {
    const ligne = compressMessage(message(1, "assistant", "Voici le rapport demandé.", {
      citations: [
        { source: "web.search" },
        { source: "email.send" },
        { source: "web.search" },
      ],
    }));
    expect(ligne).toContain("[assistant]");
    expect(ligne).toContain("outils : web.search, email.send");
    expect(ligne).toContain("résultat : succès");
  });

  it("marque « échec » quand la génération du message avait échoué", () => {
    const ligne = compressMessage(message(2, "assistant", "Réponse interrompue…", { generationStatus: "failed" }));
    expect(ligne).toContain("résultat : échec");
  });

  it("un message utilisateur ne porte ni outils ni marqueur de résultat", () => {
    const ligne = compressMessage(message(3, "user", "Peux-tu analyser ce fichier ?"));
    expect(ligne).not.toContain("outils");
    expect(ligne).not.toContain("résultat");
  });
});

describe("buildContextWindow — cas nominaux", () => {
  it("tout l'historique tient dans le budget : aucun message évacué, aucun résumé", () => {
    const history = historique(6, 200);
    const budget = estimateTokens(SYSTEME) + history.reduce((somme, m) => somme + estimateTokens(m.content), 0) + 500;
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: budget });
    expect(result.messages).toHaveLength(6);
    expect(result.droppedCount).toBe(0);
    expect(result.summaryPrefix).toBeUndefined();
    expect(result.usedTokens).toBeLessThanOrEqual(budget);
  });

  it("respecte le budget à ±5 % quand la compression s'active", () => {
    const history = historique(30, 900);
    const budget = 4_000;
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: budget });
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.usedTokens).toBeLessThanOrEqual(Math.ceil(budget * 1.05));
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("préserve l'ordre chronologique strict des messages conservés (sous-séquence de l'historique)", () => {
    const history = historique(24, 700);
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 3_000 });
    const indexes = result.messages.map((m) => Number(m.id.slice(1)));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    for (const index of indexes) {
      expect(history[index]).toBeDefined();
    }
    // le dernier message est toujours le plus récent de l'historique
    expect(result.messages[result.messages.length - 1]?.id).toBe(history[history.length - 1]?.id);
  });

  it("priorise les messages les plus récents (les évacués sont les plus anciens)", () => {
    const history = historique(24, 700);
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 3_000 });
    expect(result.droppedCount).toBeGreaterThan(0);
    const indexes = result.messages.map((m) => Number(m.id.slice(1)));
    expect(indexes[indexes.length - 1]).toBe(23);
    // les évacués sont un préfixe contigu de l'historique (hors ancre)
    expect(indexes.slice(1)).toEqual(
      indexes.slice(1).map((_, i) => history.length - (indexes.length - 1) + i),
    );
  });

  it("conserve le PREMIER message utilisateur (intention d'origine) quand son coût le permet", () => {
    const history = [
      message(0, "user", "Objectif : préparer le bilan trimestriel de l'agence."),
      ...historique(20, 900).slice(1),
    ];
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 3_200 });
    expect(result.messages[0]?.id).toBe("m0");
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toContain("bilan trimestriel");
  });

  it("est déterministe : deux exécutions produisent exactement la même sortie", () => {
    const history = historique(28, 800);
    const options = { systemPrompt: SYSTEME, history, budgetTokens: 3_000 } as const;
    const premiere = buildContextWindow(options);
    const seconde = buildContextWindow({ ...options, history: [...history] });
    expect(JSON.stringify(seconde)).toBe(JSON.stringify(premiere));
  });
});

describe("buildContextWindow — compression et résumé", () => {
  it("tronque les payloads d'outils volumineux en priorité dans le résumé", () => {
    const payload = "x".repeat(30_000);
    const history = [
      message(0, "user", "Analyse ces données du trimestre."),
      message(1, "assistant", `Résultat de l'analyse :\n${payload}`, {
        citations: [{ source: "web.search" }, { source: "file.read" }],
      }),
      message(2, "assistant", "Synthèse courte de l'étape 2."),
      message(3, "user", "Merci, continue avec la projection."),
      message(4, "assistant", "Projection réalisée : +12 % attendus."),
    ];
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 1_200 });
    expect(result.summaryPrefix).toBeDefined();
    expect(result.summaryPrefix).toContain("[assistant]");
    expect(result.summaryPrefix).toContain("outils : web.search, file.read");
    // le payload de 30 000 caractères est tronqué aux 240 premiers
    expect(result.summaryPrefix!.length).toBeLessThan(2_000);
    expect(result.summaryPrefix).not.toContain("x".repeat(COMPACT_CONTENT_CHARS + 10));
    // les messages récents courts sont conservés verbatim
    expect(result.messages[result.messages.length - 1]?.id).toBe("m4");
  });

  it("le résumé borné sacrifie les lignes les plus anciennes et annonce les omissions", () => {
    // 40 évacués aux contenus longs : le résumé (plafonné) doit tronquer.
    const history = Array.from({ length: 44 }, (_, i) =>
      message(i, i % 2 === 0 ? "user" : "assistant", `${"évitement ".repeat(120)}${i}`),
    );
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 2_600 });
    expect(result.droppedCount).toBeGreaterThan(10);
    expect(result.summaryPrefix).toBeDefined();
    expect(estimateTokens(result.summaryPrefix!)).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS);
    expect(result.summaryPrefix).toMatch(/messages antérieurs non résumés/);
    expect(result.usedTokens).toBeLessThanOrEqual(2_600);
  });

  it("un message assistant en échec est résumé avec le marqueur « échec »", () => {
    const history = [
      message(0, "assistant", "Réponse perdue — fournisseur surchargé.", { generationStatus: "failed" }),
      message(1, "assistant", `Première analyse détaillée.\n${"détail ".repeat(100)}`),
      message(2, "user", `Peux-tu approfondir le second point ?\n${"contexte ".repeat(100)}`),
      message(3, "assistant", "Voici l'approfondissement demandé."),
    ];
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 420 });
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.summaryPrefix).toBeDefined();
    expect(result.summaryPrefix).toContain("résultat : échec");
  });
});

describe("buildContextWindow — cas limites", () => {
  it("historique vide : aucun message, aucun résumé, coût du seul système", () => {
    const result = buildContextWindow({ systemPrompt: SYSTEME, history: [], budgetTokens: 2_000 });
    expect(result.messages).toEqual([]);
    expect(result.droppedCount).toBe(0);
    expect(result.summaryPrefix).toBeUndefined();
    expect(result.usedTokens).toBe(estimateTokens(SYSTEME));
  });

  it("budget minuscule : garantit système + dernier message (jamais de contexte vide)", () => {
    const history = historique(8, 1_000);
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 1 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("m7");
    // le prompt système reste compté et conservé par l'appelant (jamais droppé)
    expect(result.usedTokens).toBeGreaterThanOrEqual(estimateTokens(SYSTEME));
  });

  it("le prompt système n'est JAMAIS évacué ni amputé, quel que soit le budget", () => {
    const history = historique(12, 1_200);
    const systemeLong = `${SYSTEME}\n${"règle additionnelle du projet. ".repeat(80)}`;
    for (const budget of [1, 100, 5_000, 50_000]) {
      const result = buildContextWindow({ systemPrompt: systemeLong, history, budgetTokens: budget });
      // son coût intégral est toujours compté dans la fenêtre
      expect(result.usedTokens).toBeGreaterThanOrEqual(estimateTokens(systemeLong));
      // le système n'apparaît pas dans les messages (géré par l'appelant,
      // intact) et le dernier message est toujours là
      expect(result.messages[result.messages.length - 1]?.id).toBe("m11");
    }
  });

  it("budget négatif ou nul sur le système : la conversation reste possible", () => {
    const history = [message(0, "user", "Bonjour"), message(1, "assistant", "Bonjour, comment puis-je aider ?")];
    const result = buildContextWindow({ systemPrompt: SYSTEME, history, budgetTokens: 0 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("m1");
    expect(result.droppedCount).toBe(1);
  });
});
