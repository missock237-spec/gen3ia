import { describe, expect, it } from "vitest";

import {
  estVideoCourteRéaliste,
  extrairePhraseÀDire,
  looksLikeVoixHumaineRequest,
} from "./engine-media";

describe("estVideoCourteRéaliste — routage vidéo direct (loi CONTRAINTE-ONDES)", () => {
  it("accepte la demande de référence de l'utilisateur", () => {
    expect(estVideoCourteRéaliste("Vidéo : un homme qui marche sur une corde ( réaliste)")).toBe(true);
  });

  it("accepte une formulation simple réaliste", () => {
    expect(estVideoCourteRéaliste("génère une vidéo réaliste d'un chat qui dort")).toBe(true);
  });

  it("refuse les formats longs (production autopilotée)", () => {
    expect(estVideoCourteRéaliste("crée une vidéo documentaire réaliste de 5 minutes")).toBe(false);
    expect(estVideoCourteRéaliste("vidéo réaliste durée 30 secondes")).toBe(false);
  });

  it("refuse sans mot réaliste", () => {
    expect(estVideoCourteRéaliste("fais une vidéo d'un homme qui marche")).toBe(false);
  });
});

describe("looksLikeVoixHumaineRequest — détection serrée", () => {
  it("accepte la demande de référence de l'utilisateur", () => {
    expect(
      looksLikeVoixHumaineRequest("Voix: le message vocal doit être <<Je viens pour manger sur le bord de la route>> ( voix humaine)"),
    ).toBe(true);
  });

  it("accepte une formulation avec verbe de création", () => {
    expect(looksLikeVoixHumaineRequest("génère une voix qui dit bonjour")).toBe(true);
    expect(looksLikeVoixHumaineRequest("fais une voix humaine disant merci")).toBe(true);
  });

  it("refuse les agents téléphoniques et le mot voix seul", () => {
    expect(looksLikeVoixHumaineRequest("crée un agent standardiste")).toBe(false);
    expect(looksLikeVoixHumaineRequest("quelle est la voix passive en grammaire ?")).toBe(false);
  });
});

describe("extrairePhraseÀDire — citation prioritaire", () => {
  it("extrait la citation entre guillemets français", () => {
    expect(
      extrairePhraseÀDire("Voix : le message doit être <<Je viens pour manger sur le bord de la route>> merci"),
    ).toBe("Je viens pour manger sur le bord de la route");
  });

  it("extrait la citation entre guillemets droits", () => {
    expect(extrairePhraseÀDire('dis une voix qui dit "bonjour à tous"')).toBe("bonjour à tous");
  });

  it("retourne la demande entière sans citation", () => {
    expect(extrairePhraseÀDire("dis bonjour à tous avec une voix claire")).toBe(
      "dis bonjour à tous avec une voix claire",
    );
  });
});
