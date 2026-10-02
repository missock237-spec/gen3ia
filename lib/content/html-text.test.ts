import { describe, expect, it } from "vitest";

import { markupToText } from "./html-text";

/**
 * Machine à états HTML/XML → texte (audit CodeQL §4) : chaque test reproduit
 * une évasion RÉELLE contre les chaînes de regex historiques (bad-tag-filter,
 * double-escaping, incomplete-multi-character-sanitization) et vérifie que
 * la sortie est propre, fidèle et jamais ré-interprétée.
 */

describe("suppression de balises (bad-tag-filter fermé par le parseur)", () => {
  it("évasion par balise imbriquée : <scr<script>ipt> ne laisse RIEN d'actif", () => {
    const output = markupToText("<scr<script></script>ipt>alert(1)</scr</script>ipt>");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("<");
    // La charge utile n'est plus un élément : au pire du texte résiduel inerte.
    expect(output).not.toMatch(/<\s*script/i);
  });

  it("balise mal formée avec guillemets d'attributs : « > » dans un attribut ne coupe pas", () => {
    expect(markupToText('<a href="/x" title="a>b">libellé</a>')).toBe("libellé");
  });

  it("< orpheline = texte littéral, balise valide supprimée (comportement navigateur)", () => {
    // « 3 < 5 » : la < n'ouvre rien → littérale ; « <b>c » : balise réelle → supprimée.
    expect(markupToText("3 < 5 et a<b>c")).toBe("3 &lt; 5 et ac");
  });

  it("commentaires et CDATA entièrement ignorés", () => {
    expect(markupToText("avant<!-- <b>secret</b> -->après<![CDATA[<img src=x>]]>fin")).toBe("avantaprèsfin");
  });

  it("éléments à contenu brut ignorés jusqu'à la VRAIE fermeture (casse et attributs)", () => {
    expect(markupToText("<SCRIPT TYPE=x>if (a<b) alert(1)</ScRiPt>ok")).toBe("ok");
    expect(markupToText("<style>.x{color:red}</style>vis")).toBe("vis");
    expect(markupToText("<noscript><div>fallback</div></noscript>txt")).toBe("txt");
  });

  it("élément inconnu : contenu résiduel = texte inerte, jamais du balisage", () => {
    // <scr ipt> est un élément INCONNU : les navigateurs affichent son
    // contenu comme texte — la sécurité vient du renderer (textContent),
    // ici on garantit surtout qu'aucune < active ne survit.
    const output = markupToText("texte<scr ipt>alert('')</scr>fin");
    expect(output).not.toContain("<");
    expect(output).toContain("fin");
  });

  it("script sans fermeture : tout le reste est avalé (aucune fuite)", () => {
    expect(markupToText("a<script>if (a<b) bad()")).toBe("a");
  });
});

describe("décodage des entités (double-escaping / incomplete-multi-char fermés)", () => {
  it("chaque entité est décodée EXACTEMENT une fois — jamais de cascade", () => {
    // &amp;lt; DOIT sortir « &lt; » (texte affiché), jamais « < » re-décodé.
    expect(markupToText("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("entités nommées de base + nbsp", () => {
    expect(markupToText("A&amp;B &lt;x&gt; &quot;q&quot; &apos;s&apos; C&nbsp;D")).toBe('A&B <x> "q" \'s\' C D');
  });

  it("entités numériques décimales et hexadécimales", () => {
    expect(markupToText("&#65; &#x42; &amp;")).toBe("A B &");
    // Une pseudo-entité numérique mal formée reste littérale (fidèle navigateur).
    expect(markupToText("&#x26amp;")).toBe("&#x26amp;");
  });

  it("entité inconnue ou malformée reste littérale (pas de perte, pas de ré-interprétation)", () => {
    expect(markupToText("100€ &inconnue; &sanspointilde")).toBe("100€ &inconnue; &sanspointilde");
  });

  it("les codes de contrôle C0/C1 deviennent un espace (jamais injectés)", () => {
    expect(markupToText("a&#9;b&#x1F;c&#144;d")).toBe("a b c d");
  });
});

describe("structure du texte extrait", () => {
  it("les éléments de bloc émettent des fins de paragraphe", () => {
    expect(markupToText("<h1>Titre</h1><p>Para un</p><p>Para deux</p>")).toBe("Titre\nPara un\nPara deux");
  });

  it("<br> sépare les lignes", () => {
    expect(markupToText("ligne<br>autre<br/>fin")).toBe("ligne\nautre\nfin");
  });

  it("collpaseWhitespace=false conserve les retours structurels (DOCX)", () => {
    const xml = "<w:body><w:p>Para<w:tab/>Tab1</w:p><w:p>Suite</w:p></w:body>";
    // La fermeture du dernier <w:p> émet un \n final : l'appelant (ingestion
    // DOCX) applique déjà son trim — on le reflète ici pour tester le cœur.
    expect(markupToText(xml, { blockElements: [], tabElements: ["w:tab"], collapseWhitespace: false }).trim()).toBe(
      "Para\tTab1\nSuite",
    );
  });

  it("doctype et prolog XML ignorés", () => {
    expect(markupToText('<?xml version="1.0"?><!DOCTYPE html><p>corps</p>')).toBe("corps");
  });

  it("chaîne vide et entrée sans balise", () => {
    expect(markupToText("")).toBe("");
    expect(markupToText("juste du texte")).toBe("juste du texte");
  });
});
