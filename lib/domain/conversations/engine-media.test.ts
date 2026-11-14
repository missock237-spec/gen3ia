import { describe, expect, it } from "vitest";

import {
  estDemandeMusiqueAvecClip,
  estVideoCourteRéaliste,
  extrairePhraseÀDire,
  intentionMédiaÉtiquetée,
  looksLikeVoixHumaineRequest,
} from "./engine-media";

describe("intentionMédiaÉtiquetée — format « Image : … » de l'utilisateur", () => {
  it("reconnaît les 3 étiquettes exactes de la mission", () => {
    expect(intentionMédiaÉtiquetée("Image : un homme au bord d'une route ( photoréaliste)")).toBe("image");
    expect(intentionMédiaÉtiquetée("Voix: le message vocal doit être <<Je viens pour manger sur le bord de la route>> ( voix humaine)")).toBe("voix");
    expect(intentionMédiaÉtiquetée("Vidéo : un homme qui marche sur une corde ( réaliste)")).toBe("video");
  });

  it("refuse les messages sans étiquette en tête", () => {
    expect(intentionMédiaÉtiquetée("j'aimerais une image de chat")).toBeNull();
    expect(intentionMédiaÉtiquetée("c'est quoi une bonne vidéo ?")).toBeNull();
  });
});

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

describe("looksLikeVoixHumaineRequest — « message vocal » (fix production 19:12)", () => {
  it("détecte LA demande exacte restée sans réponse exécutable en production", () => {
    expect(looksLikeVoixHumaineRequest("Crée une message vocal d'une femme qui se présente devant un homme")).toBe(true);
    expect(looksLikeVoixHumaineRequest("Crée un message vocal de bienvenue pour mes clients")).toBe(true);
    expect(looksLikeVoixHumaineRequest("fais-moi une note vocale d'encouragement")).toBe(true);
    expect(looksLikeVoixHumaineRequest("je veux un vocal qui dit à bientôt")).toBe(true);
  });

  it("exclut toujours les agents téléphoniques et les questions méta", () => {
    expect(looksLikeVoixHumaineRequest("configure l'agent vocal de mon standard")).toBe(false);
    expect(looksLikeVoixHumaineRequest("c'est quoi un message vocal ?")).toBe(false);
  });

  it("conserve les détections historiques (« voix » + verbe)", () => {
    expect(looksLikeVoixHumaineRequest("génère une voix qui dit bonjour")).toBe(true);
  });
});

describe("estDemandeMusiqueAvecClip — routage musique+clip (exigence 2026-11-14)", () => {
  it("les demandes de chanson AVEC clip partent sur le chemin musique", () => {
    expect(estDemandeMusiqueAvecClip("crée une chanson sur le désert avec un clip musical")).toBe(true);
    expect(estDemandeMusiqueAvecClip("fais une musique en vidéo sur l'été")).toBe(true);
    expect(estDemandeMusiqueAvecClip("compose une chanson et une vidéo musicale")).toBe(true);
    expect(estDemandeMusiqueAvecClip("crée une musique avec un clip de la chanson")).toBe(true);
  });

  it("une vidéo dont la musique n'est que l'habillage reste une VIDÉO", () => {
    expect(estDemandeMusiqueAvecClip("Crée une vidéo avec une musique énergique")).toBe(false);
    expect(estDemandeMusiqueAvecClip("fais une vidéo de chat qui danse")).toBe(false);
    expect(estDemandeMusiqueAvecClip("génère une vidéo de la tour Eiffel")).toBe(false);
  });

  it("une chanson SANS clip n'est pas concernée (audio par défaut)", () => {
    expect(estDemandeMusiqueAvecClip("crée une chanson sur la mer")).toBe(false);
  });
});
