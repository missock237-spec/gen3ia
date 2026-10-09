import { describe, expect, it } from "vitest";

import { extractVideoTitle, looksLikeVideoRequest } from "./video-intent";

describe("looksLikeVideoRequest", () => {
  it("détecte les demandes FR de production vidéo", () => {
    expect(looksLikeVideoRequest("Génère une vidéo de présentation de Lyon")).toBe(true);
    expect(looksLikeVideoRequest("crée une vidéo publicitaire pour ma boulangerie")).toBe(true);
    expect(looksLikeVideoRequest("fais-moi un clip de 30 secondes sur le fitness")).toBe(true);
    expect(looksLikeVideoRequest("monte un short vertical avec des sous-titres")).toBe(true);
    expect(looksLikeVideoRequest("je veux un reel instagram sur les recettes véganes")).toBe(true);
  });

  it("détecte les demandes EN", () => {
    expect(looksLikeVideoRequest("create a video about space exploration")).toBe(true);
    expect(looksLikeVideoRequest("generate a 60s teaser for my app")).toBe(true);
  });

  it("ne déclenche PAS sur les questions méta", () => {
    expect(looksLikeVideoRequest("c'est quoi un bon montage vidéo ?")).toBe(false);
    expect(looksLikeVideoRequest("comment créer une vidéo professionnelle ?")).toBe(false);
    expect(looksLikeVideoRequest("quel logiciel de montage video choisir ?")).toBe(false);
    expect(looksLikeVideoRequest("quelle est la différence entre un clip et un reel ?")).toBe(false);
  });

  it("ne déclenche PAS sur les pages/sites web (routage artefact application)", () => {
    expect(looksLikeVideoRequest("crée une page web avec une vidéo de présentation")).toBe(false);
    expect(looksLikeVideoRequest("fais un site vitrine avec un clip d'accueil")).toBe(false);
  });

  it("ne déclenche PAS sur du texte sans verbe de création ni nom de vidéo", () => {
    expect(looksLikeVideoRequest("Le film Blade Runner est culte")).toBe(false);
    expect(looksLikeVideoRequest("bonjour")).toBe(false);
    expect(looksLikeVideoRequest("")).toBe(false);
  });
});

describe("extractVideoTitle", () => {
  it("nettoie les formules d'adresse et les articles", () => {
    expect(extractVideoTitle("Génère-moi une vidéo de présentation de Lyon")).toBe("présentation de Lyon");
    expect(extractVideoTitle("Crée une vidéo publicitaire pour ma boulangerie")).toBe("publicitaire pour ma boulangerie");
  });

  it("tronque à 80 caractères et ne rend jamais vide", () => {
    expect(extractVideoTitle("vidéo")).toBe("vidéo");
    const long = extractVideoTitle(`Génère une vidéo sur ${"x".repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Task 106-a — EXTRACTION DE PARAMÈTRES (déterministe, zéro LLM)
// ────────────────────────────────────────────────────────────────────────────

import { extractTargetDurationSec, extractVideoParams } from "./video-intent";

describe("extractTargetDurationSec (Task 106-a)", () => {
  it("lit les durées minutes/secondes explicites", () => {
    expect(extractTargetDurationSec("une vidéo de 2 minutes sur Paris")).toBe(120);
    expect(extractTargetDurationSec("90 minutes de documentaire")).toBe(3600); // plafond VIDEO_LIMITS
    expect(extractTargetDurationSec("clip de 30 secondes")).toBe(30);
    expect(extractTargetDurationSec("make a 45s teaser")).toBe(45);
  });

  it("lit les heures et demi-heures", () => {
    expect(extractTargetDurationSec("documentaire de 1h30")).toBe(3600); // plafond VIDEO_LIMITS
    expect(extractTargetDurationSec("tutoriel de 2h")).toBe(3600); // plafond VIDEO_LIMITS
    expect(extractTargetDurationSec("une demi-heure maximum")).toBe(1800);
  });

  it("lit les mots-nombres FR", () => {
    expect(extractTargetDurationSec("une minute de pitch")).toBe(60);
    expect(extractTargetDurationSec("trois minutes de résumé")).toBe(180);
  });

  it("borne à 10..3600 s et ignore l'absence de durée", () => {
    expect(extractTargetDurationSec("vidéo de 3 secondes")).toBe(10); // borne basse
    expect(extractTargetDurationSec("vidéo de 9999 minutes")).toBe(3600); // borne haute
    expect(extractTargetDurationSec("une vidéo sur le surf")).toBeUndefined();
  });
});

describe("extractVideoParams (Task 106-a)", () => {
  it("détecte plateforme → ratio + formats dérivés", () => {
    const p = extractVideoParams("crée une vidéo TikTok sur les smoothies");
    expect(p.platform).toBe("TikTok");
    expect(p.aspectRatio).toBe("9:16");
    expect(p.derivedTargets).toContain("tiktok_9_16");
  });

  it("détecte ratio explicite et formats verbaux", () => {
    expect(extractVideoParams("vidéo verticale de présentation").aspectRatio).toBe("9:16");
    expect(extractVideoParams("vidéo carrée pour le feed").aspectRatio).toBe("1:1");
    expect(extractVideoParams("vidéo 21:9 cinématique").aspectRatio).toBe("21:9");
    expect(extractVideoParams("format 16/9 classique").aspectRatio).toBe("16:9");
  });

  it("combine durée + plateforme", () => {
    const p = extractVideoParams("un reel Instagram de 45 secondes sur le yoga");
    expect(p.targetDurationSec).toBe(45);
    expect(p.platform).toBe("Instagram Reels");
    expect(p.aspectRatio).toBe("9:16");
  });

  it("multi-plateformes → formats dérivés multiples", () => {
    const p = extractVideoParams("monte une vidéo pour TikTok et YouTube");
    expect(p.derivedTargets).toContain("tiktok_9_16");
    expect(p.derivedTargets).toContain("youtube_16_9");
  });

  it("aucun paramètre → objet vide (aucune invention)", () => {
    const p = extractVideoParams("une vidéo sur l'histoire du café");
    expect(p.targetDurationSec).toBeUndefined();
    expect(p.aspectRatio).toBeUndefined();
    expect(p.platform).toBeUndefined();
    expect(p.derivedTargets).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Task 114-a — VOIX-OFF DIRECTE (intercept chat déterministe, zéro LLM)
// ────────────────────────────────────────────────────────────────────────────

import { extractVoiceRequestText, looksLikeVoiceRequest } from "./video-intent";

describe("looksLikeVoiceRequest (Task 114-a)", () => {
  it("détecte les demandes FR de voix-off", () => {
    expect(looksLikeVoiceRequest("génère une voix off pour mon spot radio")).toBe(true);
    expect(looksLikeVoiceRequest("fais-moi une voix off professionnelle du script")).toBe(true);
    expect(looksLikeVoiceRequest("j'ai besoin d'une synthèse vocale de ce paragraphe")).toBe(true);
    expect(looksLikeVoiceRequest("génère un audio qui dit bonjour à mes clients")).toBe(true);
    expect(looksLikeVoiceRequest("mets ce texte en version audio pour la radio")).toBe(true);
  });

  it("détecte la lecture à voix haute explicite", () => {
    expect(looksLikeVoiceRequest("Lis ce texte à voix haute : Bonjour à tous")).toBe(true);
    expect(looksLikeVoiceRequest("lis à voix haute le paragraphe suivant")).toBe(true);
  });

  it("ne déclenche PAS sur une demande de VIDÉO (la production vidéo gagne)", () => {
    expect(looksLikeVoiceRequest("crée une vidéo avec une voix off pour ma boulangerie")).toBe(false);
    expect(looksLikeVoiceRequest("génère une vidéo TikTok avec narration audio")).toBe(false);
  });

  it("ne déclenche PAS sur les questions méta ni le texte général", () => {
    expect(looksLikeVoiceRequest("c'est quoi une voix off ?")).toBe(false);
    expect(looksLikeVoiceRequest("comment fonctionne la synthèse vocale ?")).toBe(false);
    expect(looksLikeVoiceRequest("quel est le meilleur outil text-to-speech ?")).toBe(false);
    expect(looksLikeVoiceRequest("bonjour, comment allez-vous ?")).toBe(false);
    expect(looksLikeVoiceRequest("")).toBe(false);
  });
});

describe("extractVoiceRequestText (Task 114-a)", () => {
  it("extrait le texte après « voix off disant X »", () => {
    expect(extractVoiceRequestText("voix off disant Bienvenue chez Gen3ia")).toEqual({
      text2speak: "Bienvenue chez Gen3ia",
    });
  });

  it("extrait le texte après « génère un audio qui dit X »", () => {
    const result = extractVoiceRequestText("Génère un audio qui dit Bonjour le monde");
    expect(result?.text2speak).toBe("Bonjour le monde");
  });

  it("extrait le texte après « lis ce texte à voix haute : X »", () => {
    expect(extractVoiceRequestText("Lis ce texte à voix haute : Merci pour votre commande")).toEqual({
      text2speak: "Merci pour votre commande",
    });
  });

  it("extrait le texte après deux-points (« voix off : X »)", () => {
    expect(extractVoiceRequestText("voix off : Bienvenue chez Gen3ia, la plateforme des agents IA")).toEqual({
      text2speak: "Bienvenue chez Gen3ia, la plateforme des agents IA",
    });
  });

  it("extrait le texte cité entre guillemets", () => {
    const result = extractVoiceRequestText('fais une voix off avec "Solde insuffisant, veuillez recharger"');
    expect(result?.text2speak).toBe("Solde insuffisant, veuillez recharger");
  });

  it("nettoie les guillemets autour du texte parlé", () => {
    expect(extractVoiceRequestText("voix off disant « bienvenue à tous »")?.text2speak).toBe("bienvenue à tous");
  });

  it("retourne null sans texte exploitable (le flux normal prend le relais)", () => {
    expect(extractVoiceRequestText("j'ai besoin d'une voix off pour mon spot")).toBeNull();
    expect(extractVoiceRequestText("c'est quoi une voix off ?")).toBeNull();
    expect(extractVoiceRequestText("")).toBeNull();
  });

  it("borne le texte à synthétiser (2 500 caractères)", () => {
    const result = extractVoiceRequestText(`voix off disant ${"x".repeat(4000)}`);
    expect(result?.text2speak.length).toBeLessThanOrEqual(2500);
  });
});
