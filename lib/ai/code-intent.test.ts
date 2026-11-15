import { describe, expect, it } from "vitest";

/**
 * Task 121 — DÉTECTION DES DEMANDES DE CODE (lib/ai/code-intent.ts).
 *
 * Miroir des tests de video-intent : détections FR/EN (verbes accentués
 * compris — frontières unicode), exclusions (questions méta, médias,
 * pages/sites web sans dépôt), extraction du prompt Jules, extraction du
 * dépôt GitHub et suivi contextuel de la clarification « owner/repo ».
 */

import {
  detectCodeRequest,
  extractCodePrompt,
  extractGithubRepo,
  isCodeRepoClarifyingQuestion,
  isJulesPendingNotice,
  looksLikeCodeRequest,
  resolveCodeRequestFromContext,
  type CodeHistoryTurn,
} from "./code-intent";

/* ------------------------------------------------------------------ */
/* Détection directe FR                                                */
/* ------------------------------------------------------------------ */

describe("détection de demande de code — FR", () => {
  it("détecte verbe + nom de code (écrire une fonction)", () => {
    expect(looksLikeCodeRequest("Écris une fonction qui valide un email en TypeScript")).toBe(true);
  });

  it("détecte les verbes accentués (implémente, corrige, refactore)", () => {
    expect(looksLikeCodeRequest("Implémente un endpoint de santé dans l'api")).toBe(true);
    expect(looksLikeCodeRequest("Corrige le bug de connexion sur la page de login")).toBe(true);
    expect(looksLikeCodeRequest("Refactore le module de paiement")).toBe(true);
    expect(looksLikeCodeRequest("Développe la fonctionnalité d'export CSV")).toBe(true);
  });

  it("détecte un dépôt GitHub nommé même sans nom de code", () => {
    expect(looksLikeCodeRequest("travaille sur acme/api et arrange ce qui cloche")).toBe(true);
  });

  it("ignore les messages trop courts et hors-sujet", () => {
    expect(looksLikeCodeRequest("ok")).toBe(false);
    expect(looksLikeCodeRequest("merci beaucoup pour tout")).toBe(false);
  });

  it("ignore les questions méta (curiosité, pas une commande)", () => {
    expect(looksLikeCodeRequest("comment créer une fonction en Python ?")).toBe(false);
    expect(looksLikeCodeRequest("c'est quoi un bug en programmation ?")).toBe(false);
    expect(looksLikeCodeRequest("quelle est la différence entre un module et un composant ?")).toBe(false);
    expect(looksLikeCodeRequest("pourquoi mon code ne compile pas ?")).toBe(false);
  });

  it("laisse la priorité aux demandes vidéo, audio, image et graphique", () => {
    expect(looksLikeCodeRequest("Crée une vidéo de présentation du produit")).toBe(false);
    expect(looksLikeCodeRequest("génère une voix off disant bonjour")).toBe(false);
    expect(looksLikeCodeRequest("dessine un logo pour mon api de recettes")).toBe(false);
    expect(looksLikeCodeRequest("crée un graphique des ventes par mois")).toBe(false);
  });

  it("laisse les pages/sites web SANS dépôt au routage artefact application", () => {
    expect(looksLikeCodeRequest("crée une page web de liste de tâches")).toBe(false);
    expect(looksLikeCodeRequest("fais-moi un site vitrine pour mon restaurant")).toBe(false);
    expect(looksLikeCodeRequest("développe une application web de budget")).toBe(false);
  });

  it("prend le relais sur une « page »/« app » QUAND un dépôt GitHub est nommé", () => {
    expect(looksLikeCodeRequest("ajoute une page de contact dans le dépôt acme/api")).toBe(true);
    expect(looksLikeCodeRequest("développe une app de devis sur https://github.com/acme/api")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Détection directe EN                                                */
/* ------------------------------------------------------------------ */

describe("détection de demande de code — EN", () => {
  it("détecte write/build/fix/implement + code noun", () => {
    expect(looksLikeCodeRequest("Write a function that parses CSV files")).toBe(true);
    expect(looksLikeCodeRequest("Fix the login bug in the auth module")).toBe(true);
    expect(looksLikeCodeRequest("Build a script to deploy the api")).toBe(true);
    expect(looksLikeCodeRequest("Refactor the payment service please")).toBe(true);
    expect(looksLikeCodeRequest("implement a new endpoint for the users api")).toBe(true);
  });

  it("ignore les questions méta EN", () => {
    expect(looksLikeCodeRequest("How do I write a function in JavaScript?")).toBe(false);
    expect(looksLikeCodeRequest("What is a pull request?")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* detectCodeRequest — confiance + prompt + dépôt                      */
/* ------------------------------------------------------------------ */

describe("detectCodeRequest — contrat complet", () => {
  it("retourne isCodeRequest + promptExtraction + confiance élevée pour un verbe fort", () => {
    const result = detectCodeRequest("Peux-tu écrire une fonction de validation d'email ?");
    expect(result.isCodeRequest).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.promptExtraction).toContain("écrire une fonction de validation d'email");
    expect(result.promptExtraction).not.toMatch(/^peux-tu/i);
  });

  it("confiance moyenne pour un verbe faible (je veux…)", () => {
    const result = detectCodeRequest("je veux un script de sauvegarde");
    expect(result.isCodeRequest).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("négatif : confidence low et prompt vide", () => {
    const result = detectCodeRequest("quel temps fera-t-il demain ?");
    expect(result.isCodeRequest).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.promptExtraction).toBe("");
  });

  it("borne le prompt Jules (4000 caractères max)", () => {
    const result = detectCodeRequest("écris une fonction " + "très longue ".repeat(1000));
    expect(result.promptExtraction.length).toBeLessThanOrEqual(4000);
  });

  it("extrait le dépôt GitHub de la demande", () => {
    const result = detectCodeRequest("corrige le bug de panier dans acme/store-front");
    expect(result.repo).toEqual({ owner: "acme", repo: "store-front" });
  });
});

/* ------------------------------------------------------------------ */
/* extractCodePrompt — nettoyage déterministe                          */
/* ------------------------------------------------------------------ */

describe("extractCodePrompt", () => {
  it("retire salutations et formules de politesse, garde le cœur technique", () => {
    expect(extractCodePrompt("Bonjour, peux-tu corriger le bug de login stp ?")).toBe("corriger le bug de login");
  });

  it("normalise les espaces", () => {
    expect(extractCodePrompt("écris   une\nfonction\tde  tri")).toBe("écris une fonction de tri");
  });
});

/* ------------------------------------------------------------------ */
/* extractGithubRepo — URL et format nu                                */
/* ------------------------------------------------------------------ */

describe("extractGithubRepo", () => {
  it("extrait une URL GitHub complète", () => {
    expect(extractGithubRepo("travaille sur https://github.com/octocat/Hello-World s'il te plaît")).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("extrait un format nu owner/repo dans une phrase", () => {
    expect(extractGithubRepo("corrige le bug dans acme/api")).toEqual({ owner: "acme", repo: "api" });
  });

  it("retire le suffixe .git", () => {
    expect(extractGithubRepo("clone acme/api.git et corrige les tests")).toEqual({ owner: "acme", repo: "api" });
  });

  it("ignore les faux positifs (unités, dates)", () => {
    expect(extractGithubRepo("je travaille 24/7 sur ce projet")).toBeNull();
    expect(extractGithubRepo("on roule à 90 km/h max")).toBeNull();
    expect(extractGithubRepo("and/or c'est ambigu")).toBeNull();
  });

  it("retourne null sans dépôt", () => {
    expect(extractGithubRepo("écris une fonction de tri")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Clarification et avis — détection des messages assistant            */
/* ------------------------------------------------------------------ */

describe("isCodeRepoClarifyingQuestion / isJulesPendingNotice", () => {
  it("reconnaît la question de clarification dépôt (les deux marqueurs + ?)", () => {
    expect(
      isCodeRepoClarifyingQuestion(
        "Sur quel dépôt GitHub dois-je travailler ? Répondez au format owner/repo (ex. : mon-compte/mon-projet).",
      ),
    ).toBe(true);
  });

  it("rejette une question qui n'est pas celle du dépôt", () => {
    expect(isCodeRepoClarifyingQuestion("Quel texte souhaitez-vous entendre dans cet audio ?")).toBe(false);
    expect(isCodeRepoClarifyingQuestion("Voici le résultat de votre vidéo.")).toBe(false);
  });

  it("rejette la même formulation sans point d'interrogation", () => {
    expect(isCodeRepoClarifyingQuestion("Sur quel dépôt GitHub travailler, au format owner/repo.")).toBe(false);
  });

  it("reconnaît l'avis Jules en préparation (jules.google + JULES_API_KEY)", () => {
    expect(
      isJulesPendingNotice(
        "L'intégration de l'agent de code Jules (jules.google) est en préparation : la clé JULES_API_KEY reste à configurer.",
      ),
    ).toBe(true);
  });

  it("ne confond pas l'avis avec le message de lancement d'une session", () => {
    expect(isJulesPendingNotice("Votre tâche Jules est lancée sur le dépôt acme/api. Je surveille l'avancement.")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* resolveCodeRequestFromContext — suivi contextuel                     */
/* ------------------------------------------------------------------ */

describe("resolveCodeRequestFromContext", () => {
  const clarification: CodeHistoryTurn = {
    role: "assistant",
    content:
      "Sur quel dépôt GitHub dois-je travailler ? Répondez au format owner/repo (ex. : mon-compte/mon-projet), ou collez simplement l'URL GitHub du dépôt.",
  };

  it("source direct : la demande porte l'intention et éventuellement le dépôt", () => {
    const resolution = resolveCodeRequestFromContext("écris une fonction de validation dans acme/api", []);
    expect(resolution?.source).toBe("direct");
    expect(resolution?.repo).toEqual({ owner: "acme", repo: "api" });
  });

  it("source context : la réponse owner/repo est reliée à la demande d'origine", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Corrige le bug de calcul du panier" },
      clarification,
    ];
    const resolution = resolveCodeRequestFromContext("acme/store-front", history);
    expect(resolution?.source).toBe("context");
    expect(resolution?.repo).toEqual({ owner: "acme", repo: "store-front" });
    // Le prompt transmis à Jules est celui de la demande D'ORIGINE.
    expect(resolution?.promptExtraction).toContain("bug de calcul du panier");
  });

  it("source context : accepte une URL GitHub en réponse", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Refactore le module de paiement" },
      clarification,
    ];
    const resolution = resolveCodeRequestFromContext("https://github.com/acme/payments", history);
    expect(resolution?.repo).toEqual({ owner: "acme", repo: "payments" });
  });

  it("refus explicite → null (pas de session lancée)", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Corrige le bug de calcul" },
      clarification,
    ];
    expect(resolveCodeRequestFromContext("non, annule", history)).toBeNull();
  });

  it("réponse sans dépôt identifiable → null (flux normal)", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Corrige le bug de calcul" },
      clarification,
    ];
    expect(resolveCodeRequestFromContext("je ne sais pas trop", history)).toBeNull();
  });

  it("avis Jules en préparation déjà envoyé → null (l'agent traite via le flux normal, jamais en boucle)", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Écris une fonction de tri" },
      {
        role: "assistant",
        content:
          "L'intégration de l'agent de code Jules (jules.google) est en préparation sur la plateforme : la clé d'API (JULES_API_KEY) reste à configurer côté hébergement. En attendant, je traite votre demande directement ici avec mes outils internes.",
      },
    ];
    // L'utilisateur RENVOIE sa demande de code : le garde fait retomber le
    // tour dans le flux normal (chat agent) au lieu de répéter l'avis.
    expect(resolveCodeRequestFromContext("Écris une fonction de tri rapide", history)).toBeNull();
  });

  it("l'avis Jules n'inhibe que s'il est le DERNIER message assistant (réponse complète ensuite → détection normale)", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Écris une fonction de tri" },
      {
        role: "assistant",
        content: "L'intégration de l'agent de code Jules (jules.google) est en préparation : la clé JULES_API_KEY reste à configurer.",
      },
      { role: "user", content: "ok fais-le avec tes outils internes" },
      { role: "assistant", content: "Voici votre fonction de tri rapide, écrite en TypeScript…" },
    ];
    const resolution = resolveCodeRequestFromContext("écris aussi une fonction de recherche binaire", history);
    expect(resolution?.source).toBe("direct");
  });

  it("une réponse complète de l'assistant entre-temps rompt le suivi", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "Corrige le bug de calcul" },
      clarification,
      { role: "assistant", content: "Voici une explication détaillée du fonctionnement du panier." },
    ];
    expect(resolveCodeRequestFromContext("acme/store-front", history)).toBeNull();
  });

  it("la demande d'origine doit être une demande de code", () => {
    const history: CodeHistoryTurn[] = [
      { role: "user", content: "parle-moi de Paris" },
      clarification,
    ];
    expect(resolveCodeRequestFromContext("acme/store-front", history)).toBeNull();
  });
});
