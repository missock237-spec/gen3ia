import { describe, expect, it } from "vitest";
import {
  extraireTitreChanson,
  inventerTitreChanson,
  parolesDeterministes,
} from "./paroles";

describe("extraireTitreChanson — le titre CITÉ est détecté (exigence 2026-11-14)", () => {
  it("détecte « titre : »", () => {
    expect(extraireTitreChanson("Crée une chanson titre : Étoiles Filantes")).toBe("Étoiles Filantes");
    expect(extraireTitreChanson("une musique de 2 min, titre: Nuit Calme")).toBe("Nuit Calme");
  });

  it("détecte les verbes d'appellation", () => {
    expect(extraireTitreChanson("une chanson intitulée Promesse d'aube")).toBe("Promesse d'aube");
    expect(extraireTitreChanson("compose une musique appelée « Voyage »")).toBe("Voyage");
    expect(extraireTitreChanson("une chanson qui s'appelle Le Pont")).toBe("Le Pont");
    expect(extraireTitreChanson("fais une musique nommée Horizon")).toBe("Horizon");
  });

  it("détecte un titre entre guillemets français ou anglais", () => {
    expect(extraireTitreChanson('crée une chanson "Fils du vent"')).toBe("Fils du vent");
    expect(extraireTitreChanson("une musique « Pluie d'été » tranquille")).toBe("Pluie d'été");
  });

  it("AUCUN titre cité → null (gen3 en inventera un)", () => {
    expect(extraireTitreChanson("crée une chanson sur la mer et les vagues")).toBeNull();
    expect(extraireTitreChanson("une musique calme de 90 secondes")).toBeNull();
  });
});

describe("inventerTitreChanson — gen3 donne un titre LUI-MÊME", () => {
  it("titre inventé depuis le thème (mots porteurs)", () => {
    const titre = inventerTitreChanson("crée une chanson sur la mer et les vagues de l'océan");
    expect(titre.length).toBeGreaterThan(2);
    expect(titre.toLowerCase()).toContain("mer");
  });

  it("déterministe : même demande → même titre (cache R2)", () => {
    const demande = "une musique joyeuse sur les montagnes au printemps";
    expect(inventerTitreChanson(demande)).toBe(inventerTitreChanson(demande));
  });

  it("sans thème exploitable → titre de repli non vide", () => {
    expect(inventerTitreChanson("crée une musique de 2 min")).not.toBe("");
  });
});

describe("parolesDeterministes — repli honnête SUR le titre", () => {
  it("le titre figure dans intro, couplets et refrain", () => {
    const paroles = parolesDeterministes("Étoiles Filantes");
    expect(paroles.intro.join(" ")).toContain("Étoiles Filantes");
    expect(paroles.refrain.join(" ")).toContain("Étoiles Filantes");
    expect(paroles.couplets.length).toBeGreaterThanOrEqual(2);
    expect(paroles.source).toBe("repli-deterministe");
  });
});
