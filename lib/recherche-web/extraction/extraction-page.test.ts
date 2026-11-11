import { describe, expect, it } from "vitest";

import { extrairePageHtml } from "./extraction-page";

/** Fixture article réaliste : JSON-LD, OpenGraph, nav, contenu principal. */
const ARTICLE_HTML = `
<!doctype html>
<html lang="fr">
<head>
  <title>Titre du navigateur</title>
  <meta property="og:title" content="Titre OpenGraph de l'article" />
  <meta property="og:description" content="Description OpenGraph de l'article de test." />
  <meta property="article:published_time" content="2026-11-05T08:30:00Z" />
  <script type="application/ld+json">
    {"@type":"NewsArticle","headline":"Titre JSON-LD","datePublished":"2026-11-05T08:30:00Z","author":{"name":"Marie Curie"}}
  </script>
</head>
<body>
  <nav><a href="/">Accueil</a> <a href="/rubrique">Rubrique</a></nav>
  <article>
    <h1>Titre JSON-LD</h1>
    <p>Premier paragraphe du contenu principal avec suffisamment de texte pour dépasser le seuil de densité exigé par le module d'extraction de gen3ia pendant ses tests automatisés réels.</p>
    <p>Deuxième paragraphe qui ajoute du contenu, des chiffres, des citations et des détails réels pour que la densité de texte du bloc article reste dominante face aux blocs de navigation de la page de test.</p>
  </article>
  <footer>© 2026 Site de test — mentions légales</footer>
</body>
</html>
`;

describe("recherche-web — extraction structurée de page (Cheerio)", () => {
  it("extrait titre, description, date et auteur des métadonnées", () => {
    const page = extrairePageHtml(ARTICLE_HTML, "https://exemple.com/article");
    expect(page.titre).toBe("Titre OpenGraph de l'article");
    expect(page.description).toBe("Description OpenGraph de l'article de test.");
    expect(page.datePublication).toBe("2026-11-05T08:30:00Z");
    expect(page.auteur).toBe("Marie Curie");
    expect(page.caracteresBruts).toBeGreaterThan(200);
  });

  it("le texte principal contient l'article mais pas la navigation ni le footer", () => {
    const page = extrairePageHtml(ARTICLE_HTML, "https://exemple.com/article");
    expect(page.texte).toContain("Premier paragraphe");
    expect(page.texte).toContain("Deuxième paragraphe");
    expect(page.texte).not.toContain("Rubrique");
    expect(page.texte).not.toContain("mentions légales");
  });

  it("tolère un JSON-LD malformé sans tout casser", () => {
    const html = ARTICLE_HTML.replace(
      '"datePublished":"2026-11-05T08:30:00Z"',
      '"datePublished":BROKEN', // invalide
    );
    const page = extrairePageHtml(html, "https://exemple.com/article");
    // Le reste de l'extraction continue de fonctionner (OpenGraph).
    expect(page.titre).toBe("Titre OpenGraph de l'article");
    expect(page.datePublication).toBe("2026-11-05T08:30:00Z");
  });

  it("page minimale sans métadonnées : titre h1 et body en repli", () => {
    const page = extrairePageHtml(
      "<html><body><h1>Seul titre</h1><p>Texte du corps relativement court mais présent.</p></body></html>",
      "https://exemple.com/min",
    );
    expect(page.titre).toBe("Seul titre");
    expect(page.texte).toContain("Texte du corps");
  });

  it("JSON-LD en tableau (graph schema.org) est supporté", () => {
    const html = `<html><head><script type="application/ld+json">
      [{"@type":"WebSite","name":"Site"},{"@type":"Article","headline":"Titre graph","author":{"name":"Ada"}}]
    </script></head><body><article><p>Contenu du graph avec texte assez long pour passer le seuil de densité de l'extraction gen3ia en test réel automatisé.</p></article></body></html>`;
    const page = extrairePageHtml(html, "https://exemple.com/graph");
    expect(page.titre).toBe("Titre graph");
    expect(page.auteur).toBe("Ada");
  });
});
