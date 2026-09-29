import { describe, expect, it } from "vitest";

import { FAQ_EN, FAQ_FR, brandPitch, buildStructuredData } from "@/lib/geo/content";

/**
 * Garde-fous GEO — le contenu citable par les moteurs de réponse IA
 * (ChatGPT, Perplexity, Gemini, Claude) ne doit jamais se dégrader :
 * réponses autosuffisantes, JSON-LD complet, cohérence FR/EN.
 */
describe("GEO : contenu citable (lib/geo/content)", () => {
  it.each([[FAQ_FR], [FAQ_EN]])("la FAQ contient au moins 8 Q/R exploitables", (faq) => {
    expect(faq.length).toBeGreaterThanOrEqual(8);
    for (const item of faq) {
      expect(item.question.length).toBeGreaterThan(8);
      // Une réponse citable doit être autosuffisante : ni trop courte,
      // ni dépendante d'un contexte absent ("voir ci-dessus" interdit).
      expect(item.answer.length).toBeGreaterThan(80);
      expect(item.answer).not.toMatch(/ci-?dessus|ci-?dessous|see (above|below)/i);
    }
  });

  it("les FAQ FR et EN couvrent les mêmes 8 questions (par position)", () => {
    expect(FAQ_FR).toHaveLength(FAQ_EN.length);
    for (let i = 0; i < FAQ_FR.length; i += 1) {
      expect(FAQ_FR[i].answer.length).toBeGreaterThan(0);
      expect(FAQ_EN[i].answer.length).toBeGreaterThan(0);
    }
  });

  it("le JSON-LD FR expose le quatuor schema.org complet", () => {
    const jsonLd = buildStructuredData("fr");
    expect(jsonLd["@context"]).toBe("https://schema.org");
    const types = jsonLd["@graph"].map((node: { "@type": string }) => node["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
    expect(types).toContain("FAQPage");

    const faqPage = jsonLd["@graph"].find((node: { "@type": string }) => node["@type"] === "FAQPage");
    expect(faqPage.mainEntity).toHaveLength(FAQ_FR.length);
    expect(faqPage.mainEntity[0].name).toBe(FAQ_FR[0].question);
    expect(faqPage.mainEntity[0].acceptedAnswer.text).toBe(FAQ_FR[0].answer);
  });

  it("le JSON-LD EN est localisé (URL /en, inLanguage en, FAQ EN)", () => {
    const jsonLd = buildStructuredData("en");
    const website = jsonLd["@graph"].find((node: { "@type": string }) => node["@type"] === "WebSite");
    expect(website.url).toMatch(/\/en$/);
    expect(website.inLanguage).toBe("en");

    const faqPage = jsonLd["@graph"].find((node: { "@type": string }) => node["@type"] === "FAQPage");
    expect(faqPage.mainEntity[0].name).toBe(FAQ_EN[0].question);
  });

  it("SoftwareApplication déclare une offre gratuite et des plateformes", () => {
    for (const lang of ["fr", "en"] as const) {
      const app = buildStructuredData(lang)["@graph"].find(
        (node: { "@type": string }) => node["@type"] === "SoftwareApplication"
      );
      expect(app.offers.price).toBe("0");
      expect(app.operatingSystem).toMatch(/Windows/);
      expect(app.featureList.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("le pitch de marque est localisé et autosuffisant", () => {
    expect(brandPitch("fr")).toMatch(/agents IA autonomes/);
    expect(brandPitch("en")).toMatch(/autonomous AI agent platform/);
  });
});
