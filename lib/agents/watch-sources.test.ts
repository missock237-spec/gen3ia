import { describe, expect, it } from "vitest";

import { hashSourceContent, normalizeSourceContent, createWatchSource, checkWatchSource } from "./watch-sources";

describe("normalisation des sources de veille", () => {
  it("retire les dates volatiles d'un flux RSS", () => {
    const feed = `<?xml version="1.0"?><rss><channel><title>Actu</title>
      <lastBuildDate>Tue, 15 Jan 2026 10:00:00 GMT</lastBuildDate>
      <item><title>Article</title><pubDate>Mon, 14 Jan 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const normalized = normalizeSourceContent("rss", feed);
    expect(normalized).not.toContain("lastBuildDate".toLowerCase());
    expect(normalized).not.toContain("2026");
    expect(normalized).toContain("Article");
    expect(normalized).toContain("Actu");
  });

  it("retire scripts et styles d'une page web", () => {
    const page = `<html><head><style>body{color:red}</style></head>
      <body><h1>Titre</h1><script>var stamp = Date.now();</script><p>Contenu</p></body></html>`;
    const normalized = normalizeSourceContent("web", page);
    expect(normalized).not.toContain("Date.now()");
    expect(normalized).not.toContain("color:red");
    expect(normalized).toContain("Titre");
    expect(normalized).toContain("Contenu");
  });

  it("produit un hash stable et différent en cas de changement", () => {
    const before = "<item><title>Version 1</title></item>";
    const after = "<item><title>Version 2</title></item>";
    expect(hashSourceContent(normalizeSourceContent("rss", before)))
      .toBe(hashSourceContent(normalizeSourceContent("rss", before)));
    expect(hashSourceContent(normalizeSourceContent("rss", before)))
      .not.toBe(hashSourceContent(normalizeSourceContent("rss", after)));
  });
});

describe("createWatchSource", () => {
  it("attribue un id et nettoie le libellé", () => {
    const source = createWatchSource({ type: "rss", url: "https://exemple.com/feed", label: "  Veille concurrentielle  " });
    expect(source.id).toMatch(/^[0-9a-f-]{10,}$/);
    expect(source.label).toBe("Veille concurrentielle");
    const anonymous = createWatchSource({ type: "web", url: "https://exemple.com" });
    expect(anonymous.label).toBeUndefined();
  });
});
