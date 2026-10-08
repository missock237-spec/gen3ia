import { describe, expect, it } from "vitest";

import { splitSentences } from "./sentence-split";

/**
 * Tests de la découpe FR (Task 110-a) : abréviations (M., Mme, Dr, Pr…),
 * décimaux, terminators (! ? …), sauts de ligne, regroupement ~200–240
 * caractères, texte vide.
 *
 * Astuce de calibrage : le REGROUPEMENT masque une mauvaise découpe tant que
 * les fragments fusionnent sous le plafond. Pour verrouiller la position des
 * frontières, les phrases de test sont gonflées au-delà de 240 caractères :
 * une frontière en trop produit alors un chunk supplémentaire visible.
 */

/** Phrase longue (~196 caractères) : deux phrases de ce gabarit → 2 chunks. */
const PHRASE_LONGUE =
  "Voici la synthèse détaillée de votre activité commerciale sur les douze derniers mois avec les tendances par canal de vente, les marges observées et les points d'attention pour le trimestre à venir.";

/** Construit une phrase d'au moins `cible` caractères, terminée par `fin`. */
function remplir(prefixe: string, cible: number, fin: string): string {
  let phrase = prefixe;
  const mot = " biscotte";
  while (phrase.length < cible) phrase += mot;
  return phrase + fin;
}

describe("splitSentences — découpe FR pour le TTS Live Voix", () => {
  it("texte vide ou blanc → tableau vide", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n\t  ")).toEqual([]);
  });

  it("le point d'abréviation M. ne termine PAS une phrase (frontière en trop sinon)", () => {
    const phrase1 = remplir("Bonjour M. Dupont reçoit", 260, ".");
    const phrase2 = remplir("Ensuite", 200, ".");
    const chunks = splitSentences(`${phrase1} ${phrase2}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("Bonjour M. Dupont reçoit");
  });

  it("le point d'un décimal (3.5) ne termine PAS une phrase", () => {
    const phrase1 = remplir("La croissance atteint 3.5 pour cent", 260, ".");
    const phrase2 = remplir("Ensuite", 200, ".");
    const chunks = splitSentences(`${phrase1} ${phrase2}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("3.5");
  });

  it("Mme et Dr en milieu de phrase ne créent aucune frontière", () => {
    const texte = "Mme Durand et le Dr Martin ont confirmé.";
    expect(splitSentences(texte)).toEqual(["Mme Durand et le Dr Martin ont confirmé."]);
  });

  it("coupe sur . ! ? et regroupe les phrases courtes dans un seul chunk", () => {
    const chunks = splitSentences("Bonjour ! Comment vas-tu ? Très bien, merci.");
    expect(chunks).toEqual(["Bonjour ! Comment vas-tu ? Très bien, merci."]);
  });

  it("regroupe sans jamais dépasser le plafond (240) et conserve le texte", () => {
    const texte = [
      "Premier point important pour la suite de notre échange.",
      "Deuxième point tout aussi essentiel à retenir.",
      "Troisième point complémentaire pour compléter la réponse.",
      "Quatrième point final qui conclut proprement la liste courte.",
    ].join(" ");
    const chunks = splitSentences(texte);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(240);
    }
    expect(chunks.join(" ")).toBe(texte);
  });

  it("deux phrases longues donnent deux chunks distincts", () => {
    const texte = `${PHRASE_LONGUE} ${PHRASE_LONGUE.replace("Voici", "Voilà")}`;
    const chunks = splitSentences(texte);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(PHRASE_LONGUE);
    expect(chunks[1]).toBe(PHRASE_LONGUE.replace("Voici", "Voilà"));
  });

  it("une phrase plus longue que le plafond reste ENTIÈRE (jamais de coupe intra-phrase)", () => {
    const tresLongue = remplir("Ceci est une phrase volontairement très longue", 300, ".");
    expect(splitSentences(tresLongue)).toEqual([tresLongue]);
  });

  it("les sauts de ligne séparent les phrases (titres, alinéas)", () => {
    const texte = `${PHRASE_LONGUE}\n${PHRASE_LONGUE.replace("Voici", "Ensuite")}`;
    const chunks = splitSentences(texte);
    expect(chunks).toHaveLength(2);
  });

  it("les points de suspension (…) terminent une phrase", () => {
    const phrase1 = remplir("Je vérifie cela immédiatement", 260, "…");
    const phrase2 = remplir("Ensuite", 200, ".");
    const chunks = splitSentences(`${phrase1} ${phrase2}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.endsWith("…")).toBe(true);
    expect(chunks[0]).toContain("Je vérifie cela immédiatement");
  });

  it("les terminators consécutifs restent dans la phrase (?! !!)", () => {
    expect(splitSentences("C'est incroyable !! Vraiment ?! Oui.")).toEqual([
      "C'est incroyable !! Vraiment ?! Oui.",
    ]);
  });

  it("conservation : la concaténation des chunks retrouve le texte (espace près)", () => {
    const texte = `Salutations d'usage. ${PHRASE_LONGUE} Une dernière phrase courte.`;
    const chunks = splitSentences(texte);
    expect(chunks.join(" ")).toBe(texte.replace(/\s+/g, " ").trim());
  });
});
