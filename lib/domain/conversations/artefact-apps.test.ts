import { describe, expect, it } from "vitest";

import {
  appendPreviewLinks,
  buildAppUserRequest,
  buildChartHtml,
  chartDataFromTable,
  chartTypeFromMessage,
  detectAppCreationIntent,
  detectChartIntent,
  extractAppTitle,
  extractHtmlDocument,
  extractInlineData,
  previewLinkMarkdown,
} from "./artefact-apps";
import type { ConversationArtifact } from "./types";

function artifact(partial: Partial<ConversationArtifact>): ConversationArtifact {
  return {
    id: "a1",
    userId: "u1",
    type: "code",
    title: "Liste de tâches",
    language: "html",
    content: "<!DOCTYPE html><html></html>",
    versions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("detectAppCreationIntent", () => {
  it("détecte l'exemple canonique de la fonctionnalité Artefacts", () => {
    const intent = detectAppCreationIntent("agent ia, aidez-moi à créer une page web de liste de tâches en mode sombre, écrite en React.");
    expect(intent).not.toBeNull();
    expect(intent?.wantsReact).toBe(true);
    expect(intent?.theme).toBe("dark");
  });

  it("détecte les formulations courantes de création web", () => {
    expect(detectAppCreationIntent("Développe une application web de gestion de contacts")).not.toBeNull();
    expect(detectAppCreationIntent("Génère un tableau de bord de ventes")).not.toBeNull();
    expect(detectAppCreationIntent("Crée un portfolio moderne")).not.toBeNull();
    expect(detectAppCreationIntent("construis un jeu de memory")).not.toBeNull();
  });

  it("route les documents, images et emails vers leurs tours dédiés", () => {
    expect(detectAppCreationIntent("crée une présentation PowerPoint de lancement produit")).toBeNull();
    expect(detectAppCreationIntent("crée un rapport PDF sur l'IA")).toBeNull();
    expect(detectAppCreationIntent("génère une image d'un chat")).toBeNull();
    expect(detectAppCreationIntent("envoie un email à jean@exemple.com")).toBeNull();
  });

  it("ignore les demandes sans verbe de création ni objet web", () => {
    expect(detectAppCreationIntent("bonjour, comment vas-tu ?")).toBeNull();
    expect(detectAppCreationIntent("qu'est-ce que React ?")).toBeNull();
  });
});

describe("extractAppTitle", () => {
  it("extrait un titre lisible de la demande", () => {
    const title = extractAppTitle("aidez-moi à créer une page web de liste de tâches en mode sombre");
    expect(title.toLowerCase()).toContain("liste de tâches");
  });

  it("replie honnête sur la demande brute", () => {
    expect(extractAppTitle("ok").length).toBeGreaterThan(0);
  });
});

describe("detectChartIntent / chartTypeFromMessage", () => {
  it("détecte une demande de graphique", () => {
    expect(detectChartIntent("génère un graphique en barres des ventes")).not.toBeNull();
    expect(detectChartIntent("analyse ces données")).not.toBeNull();
    expect(detectChartIntent("analyse")).toBeNull();
  });

  it("choisit le type de graphique selon les mots-clés", () => {
    expect(chartTypeFromMessage("un camembert de répartition")).toBe("pie");
    expect(chartTypeFromMessage("la courbe d'évolution du CA")).toBe("line");
    expect(chartTypeFromMessage("un histogramme des ventes")).toBe("bar");
    expect(chartTypeFromMessage("graphique")).toBe("bar");
  });

  it("ne capte pas les images ni les présentations", () => {
    expect(detectChartIntent("crée une image d'un graphique en barres")).toBeNull();
    expect(detectChartIntent("présentation PowerPoint des ventes")).toBeNull();
  });
});

describe("extractInlineData", () => {
  it("extrait des paires label/valeur énoncées", () => {
    const data = extractInlineData("génère un graphique : Ventes: 120, Marketing: 80, Développement: 150");
    expect(data?.labels).toEqual(["Ventes", "Marketing", "Développement"]);
    expect(data?.values).toEqual([120, 80, 150]);
  });

  it("accepte les décimales et les devises", () => {
    const data = extractInlineData("Jan: 12,5 €, Fév: 18 €, Mars: 9 €");
    expect(data?.values).toEqual([12.5, 18, 9]);
  });

  it("refuse moins de 3 paires", () => {
    expect(extractInlineData("Ventes: 120, Marketing: 80")).toBeNull();
  });
});

describe("chartDataFromTable", () => {
  it("utilise la première colonne numérique d'un fichier importé", () => {
    const data = chartDataFromTable(
      ["Produit", "Prix"],
      [["A", "10"], ["B", "20"], ["C", "30"]],
      "fichier importé « ventes.csv »",
    );
    expect(data?.labels).toEqual(["A", "B", "C"]);
    expect(data?.values).toEqual([10, 20, 30]);
    expect(data?.source).toContain("ventes.csv");
  });

  it("retourne null sans colonne numérique", () => {
    expect(chartDataFromTable(["Nom"], [["A"], ["B"]], "test")).toBeNull();
  });
});

describe("extractHtmlDocument", () => {
  it("extrait un document brut", () => {
    const html = "<!DOCTYPE html><html><body>ok</body></html>";
    expect(extractHtmlDocument(html)).toBe(html);
  });

  it("extrait un document dans une fence markdown", () => {
    const fenced = "Voici le code :\n```html\n<!DOCTYPE html><html></html>\n```";
    expect(extractHtmlDocument(fenced)).toBe("<!DOCTYPE html><html></html>");
  });

  it("rejette un texte sans document HTML complet", () => {
    expect(extractHtmlDocument("juste du texte")).toBeNull();
    expect(extractHtmlDocument("<!DOCTYPE html><html>incomplet")).toBeNull();
  });
});

describe("buildChartHtml", () => {
  it("produit une page autonome avec ECharts et export PNG/JPG", () => {
    const html = buildChartHtml({
      title: "Ventes par équipe",
      chartType: "bar",
      labels: ["A", "B", "C"],
      values: [1, 2, 3],
      source: "données énoncées dans votre message",
      conclusion: "B domine.",
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("echarts.min.js");
    expect(html).toContain("Télécharger PNG");
    expect(html).toContain("Télécharger JPG");
    expect(html).toContain("B domine.");
    expect(html).toContain("Propulsé par Gen3ia");
  });

  it("neutralise les labels provenant des données utilisateur (sortie de script impossible)", () => {
    const html = buildChartHtml({
      title: "Test",
      chartType: "bar",
      labels: ["</script><script>alert(1)</script>"],
      values: [1, 2, 3],
      source: "test",
    });
    // Le payload JSON est inséré avec < échappé en \u003c : le parseur ne
    // voit jamais de balise injectée (2 fermetures = les 2 <script>
    // légitimes du document, pas un de plus).
    expect(html).toContain("\\u003c/script>");
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });
});

describe("Contrat ARTEFACTS — lien web d'aperçu", () => {
  it("ajoute le lien /preview/<id> pour les apps exécutables", () => {
    const content = appendPreviewLinks("Votre application est prête.", [artifact({ id: "app-1" })]);
    expect(content).toContain("/preview/app-1");
    expect(content).toContain("Résultat en direct");
  });

  it("ne modifie pas le message sans artefact exécutable", () => {
    const content = appendPreviewLinks("Document créé.", [artifact({ id: "d1", type: "document", content: "rapport", language: undefined })]);
    expect(content).toBe("Document créé.");
  });

  it("previewLinkMarkdown produit un lien markdown cliquable", () => {
    expect(previewLinkMarkdown(artifact({ id: "x1", title: "Liste de tâches" }))).toBe("[Liste de tâches](/preview/x1)");
  });
});

describe("buildAppUserRequest", () => {
  it("transmet la demande, le framework et le thème", () => {
    const request = buildAppUserRequest("crée une page web de liste de tâches", { title: "Liste de tâches", wantsReact: true, theme: "dark" });
    expect(request).toContain("liste de tâches");
    expect(request).toContain("React");
    expect(request).toContain("MODE SOMBRE");
    expect(request).toContain("<!DOCTYPE html>");
  });
});
