import { describe, expect, it } from "vitest";

import { ThinkTagStreamFilter, stripThinkTags } from "@/lib/ai/think-filter";

describe("stripThinkTags (texte complet)", () => {
  it("supprime un bloc fermé", () => {
    expect(stripThinkTags("<think>réfléchis</think>Bonjour !")).toBe("Bonjour !");
  });

  it("supprime un bloc non fermé en fin de texte", () => {
    expect(stripThinkTags("Réponse.<think>raisonnement sans fin…")).toBe("Réponse.");
  });

  it("gère les variantes thinking / reasoning et multi-lignes", () => {
    expect(stripThinkTags("<thinking>\nplan\n</thinking>\n\nRésultat")).toBe("Résultat");
    expect(stripThinkTags("<reasoning>x</reasoning>A")).toBe("A");
  });

  it("neutralise les espaces laissés par la suppression en tête", () => {
    expect(stripThinkTags("<think>a</think>\n\n## Titre")).toBe("## Titre");
  });

  it("ne touche pas à un texte sans balise", () => {
    const text = "Comparaison : 5 < 10 et x <y. Voilà.";
    expect(stripThinkTags(text)).toBe(text);
  });

  it("supprime plusieurs blocs", () => {
    expect(stripThinkTags("<think>1</think>A<think>2</think>B")).toBe("AB");
  });
});

describe("ThinkTagStreamFilter (flux incrémental)", () => {
  const feed = (chunks: string[]) => {
    const filter = new ThinkTagStreamFilter();
    let out = "";
    for (const chunk of chunks) out += filter.push(chunk);
    out += filter.end();
    return out;
  };

  it("laisse passer un texte sans balise", () => {
    expect(feed(["Bonjour", " le", " monde !"])).toBe("Bonjour le monde !");
  });

  it("masque un bloc contenu dans un seul delta", () => {
    expect(feed(["<think>secret</think>Visible"])).toBe("Visible");
  });

  it("masque une balise coupée entre deux chunks", () => {
    expect(feed(["<thi", "nk>raisonnement</th", "ink>Réponse finale"])).toBe("Réponse finale");
  });

  it("masque un bloc ouvert jamais fermé (stream coupé)", () => {
    expect(feed(["D'accord.<think>je commence", " à réfléchir…"])).toBe("D'accord.");
  });

  it("émet le texte avant la balise même si le bloc ne ferme jamais", () => {
    expect(feed(["<th", "inking>xx</th", "inking>OK"])).toBe("OK");
  });

  it("ne perturbe pas un vrai texte contenant un chevron", () => {
    expect(feed(["si a <", " 5 alors <b>x</b>"])).toBe("si a < 5 alors <b>x</b>");
  });

  it("concatène les fragments visibles au fil de l'eau", () => {
    const filter = new ThinkTagStreamFilter();
    const parts = [filter.push("Ré"), filter.push("<think>h</th"), filter.push("ink>"), filter.push("ponse"), filter.end()];
    expect(parts.join("")).toBe("Réponse");
  });

  it("gère une fausse piste de fermeture dans le bloc", () => {
    expect(feed(["<think>json </a et </th", "ink>Suite"])).toBe("Suite");
  });
});
