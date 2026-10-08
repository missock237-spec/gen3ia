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
