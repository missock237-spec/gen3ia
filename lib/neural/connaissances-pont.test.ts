import { describe, expect, it } from "vitest";

import {
  composerDepuisConnaissances,
  motsInformatifs,
  parserFragmentsConnaissances,
  PONT_MAX_FRAGMENTS,
} from "./connaissances-pont";

/**
 * PONT CONNAISSANCES → RÉPONSE : les documents ingérés par l'utilisateur
 * doivent atteindre le TEXTE de la réponse (avec citation de la source),
 * sans jamais inventer — aucun fragment pertinent ⇒ null (repli
 * cortex/décodeur), texte cité = fragment indexé mot pour mot.
 */

const CONTEXTE = `
- [document doc_charte, fragment 3, score 0.62]
La charte impose 25 jours de congés payés annuels et un télétravail maximum de 3 jours par semaine.

- [document doc_produit, fragment 1, score 0.41]
Le produit Gen3ia facture l'usage API au token ; le wallet est rechargé via Chariow en XAF.
`;

describe("parserFragmentsConnaissances", () => {
  it("relit les fragments du contexte (document, fragment, score, texte)", () => {
    const fragments = parserFragmentsConnaissances(CONTEXTE);
    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ documentId: "doc_charte", chunkIndex: 3, score: 0.62 });
    expect(fragments[0].texte).toContain("25 jours de congés payés");
  });

  it("ignore les blocs étrons et un contexte vide", () => {
    expect(parserFragmentsConnaissances("")).toEqual([]);
    expect(parserFragmentsConnaissances("- [document x, fragment 0]\ntrop court")).toEqual([]);
  });
});

describe("motsInformatifs", () => {
  it("écarte les mots outils et les mots courts", () => {
    expect(motsInformatifs("Que dit la charte sur les congés ?")).toEqual(["charte", "conges"]);
  });
});

describe("composerDepuisConnaissances", () => {
  it("compose une réponse CITÉE quand un fragment répond à la question", () => {
    const composition = composerDepuisConnaissances(
      "Combien de jours de congés payés prévoit la charte ?",
      CONTEXTE,
    );
    expect(composition).not.toBeNull();
    expect(composition!.source).toBe("connaissances_utilisateur");
    expect(composition!.texte).toContain("D'après vos documents");
    expect(composition!.texte).toContain("25 jours de congés payés");
    expect(composition!.texte).toContain("document doc_charte, fragment 3");
    // Le fragment concurrent (wallet) ne doit pas être cité.
    expect(composition!.texte).not.toContain("Chariow");
  });

  it("cite au plus deux documents distincts", () => {
    const contexte3 = `${CONTEXTE}
- [document doc_rh, fragment 7, score 0.55]
Les congés se posent sur l'outil RH ; validation du manager sous 5 jours ouvrés.
`;
    const composition = composerDepuisConnaissances(
      "congés payés charte rh télétravail",
      contexte3,
    );
    expect(composition).not.toBeNull();
    const sources = (composition!.texte.match(/— Source :/g) ?? []).length;
    expect(sources).toBeLessThanOrEqual(PONT_MAX_FRAGMENTS);
  });

  it("retourne null quand AUCUN fragment ne correspond (refus honnête)", () => {
    expect(
      composerDepuisConnaissances("bonjour, comment vas-tu ?", CONTEXTE),
    ).toBeNull();
  });

  it("retourne null sans contexte ou sans question", () => {
    expect(composerDepuisConnaissances("congés ?", "")).toBeNull();
    expect(composerDepuisConnaissances("", CONTEXTE)).toBeNull();
    expect(composerDepuisConnaissances("   ", CONTEXTE)).toBeNull();
  });

  it("insensible aux accents et à la casse (français)", () => {
    const composition = composerDepuisConnaissances(
      "QUE DIT LA CHARTE POUR LES TÉLÉTRAVAILS ?",
      CONTEXTE,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("télétravail");
  });
});

/* ==================================================================== */
/* RÉPARATION ARTEFACT (Job 478451) — les fichiers importés du TOUR      */
/* (loadImportedFilesContext, uni au canal knowledge par le chat) sont   */
/* lus par le pont : « lis ce fichier joint » cite la teneur RÉELLE.     */
/* ==================================================================== */

const CONTEXTE_FICHIER = `Contenu RÉEL des fichiers importés (stockés en base de données) :
Fichier importé « rapport-test-a9bd.txt » (text, 134 caractères convertis) :
Rapport de test interne — ligne 1 : le mot de passe du trésor est PONG-0B34AA4D — ligne 2 : quatre-vingt-douze pommes — ligne 3 : fin.`;

describe("parserFragmentsConnaissances — blocs « Fichier importé » (réparation artefact)", () => {
  it("relit chaque fichier importé comme un fragment de pertinence maximale", () => {
    const fragments = parserFragmentsConnaissances(CONTEXTE_FICHIER);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      documentId: "rapport-test-a9bd.txt",
      chunkIndex: 0,
      score: 1,
      origine: "fichier-importe",
    });
    expect(fragments[0].texte).toContain("PONG-0B34AA4D");
  });

  it("lit un contexte MIXTE (knowledge + fichiers importés) sans confusion de blocs", () => {
    const mixte = `${CONTEXTE_FICHIER}

---

- [document doc_charte, fragment 3, score 0.62]
La charte impose 25 jours de congés payés annuels et un télétravail maximum de 3 jours par semaine.`;
    const fragments = parserFragmentsConnaissances(mixte);
    expect(fragments).toHaveLength(2);
    expect(fragments[0].origine).toBe("fichier-importe");
    expect(fragments[0].texte).toContain("PONG-0B34AA4D");
    expect(fragments[0].texte).not.toContain("---");
    expect(fragments[1]).toMatchObject({ documentId: "doc_charte", origine: "knowledge" });
  });

  it("ignore honnêtement un bloc de fichier sans contenu réel (métadonnées seules)", () => {
    const vide = `Contenu RÉEL des fichiers importés (stockés en base de données) :
Fichier importé « photo.png » (image, métadonnées seulement) :
contenu non chargé (binaire non textuel)`;
    const fragments = parserFragmentsConnaissances(vide);
    expect(fragments).toEqual([]);
  });
});

describe("composerDepuisConnaissances — citation du fichier joint (réparation artefact)", () => {
  it("« le mot de passe du trésor » est cité MOT POUR MOT depuis le fichier importé", () => {
    const composition = composerDepuisConnaissances(
      "lis le fichier joint et réponds avec la phrase qui commence par « le mot de passe du trésor est »",
      CONTEXTE_FICHIER,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("PONG-0B34AA4D");
    expect(composition!.texte).toContain("votre fichier importé");
    expect(composition!.texte).not.toContain("base de connaissances");
  });

  it("un contexte mixte cite le fichier joint avec le titre honnête", () => {
    const mixte = `${CONTEXTE_FICHIER}

---

- [document doc_charte, fragment 3, score 0.62]
La charte impose 25 jours de congés payés annuels et un télétravail maximum de 3 jours par semaine.`;
    const composition = composerDepuisConnaissances(
      "que dit le fichier joint sur le trésor et le mot de passe, et la charte sur les congés payés ?",
      mixte,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("D'après vos documents et vos fichiers joints :");
    expect(composition!.texte).toContain("PONG-0B34AA4D");
  });
});

/* ------------------------------------------------------------------ */
/* SOURCES WEB TEMPS RÉEL — le bloc du moteur de recherche (produit par */
/* blocContexteSource) doit atteindre la réponse CITÉE avec URL réelle. */
/* ------------------------------------------------------------------ */

const BLOC_WEB = `[RECHERCHE WEB TEMPS RÉEL gen3ia — résultats RÉELS obtenus à l'instant. Moteurs interrogés : duckduckgo, bing ; moteurs ayant répondu : bing ; 3 source(s) unique(s) après dédoublonnage (1 doublon(s) retiré(s)).]

[1] L'actualité de l'intelligence artificielle en novembre 2026
URL : https://exemple-actu.com/ia-novembre-2026
Extrait : Le marché de l'intelligence artificielle connaît une accélération notable cette semaine avec de nouvelles annonces.
Publié : 2026-11-10
Moteur(s) : bing — crédibilité moyenne
[2] Cours du Bitcoin : la crypto repart à la hausse
URL : https://exemple-crypto.com/cours
Extrait : Le prix du Bitcoin évolue de 2,4 % depuis ce matin.
Moteur(s) : bing — crédibilité moyenne

CONTENU RÉEL DES PAGES LUES :
Page « L'actualité de l'intelligence artificielle en novembre 2026 » (méthode : http, publiée : 2026-11-10, auteur : Rédaction) :
Les modèles d'intelligence artificielle multimodaux dominent l'actualité technologique de novembre 2026, avec une progression mesurée des usages industriels.`;

describe("sources web temps réel — pont web (vérification navigateur intégré)", () => {
  it("le parser reconnaît les sources numérotées du bloc web avec leur URL", () => {
    const fragments = parserFragmentsConnaissances(BLOC_WEB);
    const sources = fragments.filter((f) => f.origine === "web");
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(sources[0].documentId).toBe("https://exemple-actu.com/ia-novembre-2026");
    expect(sources[0].titreSource).toContain("actualité de l'intelligence artificielle");
    expect(sources[0].texte).toContain("Extrait :");
  });

  it("la réponse cite la source web MOT POUR MOT avec son URL réelle", () => {
    const composition = composerDepuisConnaissances(
      "cherche sur le web les dernières actualités intelligence artificielle",
      BLOC_WEB,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("recherche web temps réel gen3ia");
    expect(composition!.texte).toContain("intelligence artificielle");
    expect(composition!.texte).toContain("https://exemple-actu.com/ia-novembre-2026");
    expect(composition!.texte).toContain("— Source web :");
  });

  it("une question sans rapport avec les sources web retourne null (repli honnête)", () => {
    const composition = composerDepuisConnaissances(
      "quelle est la recette du gâteau au chocolat ?",
      BLOC_WEB,
    );
    expect(composition).toBeNull();
  });

  it("un bloc web mélangé à la connaissance projet et aux fichiers joints reste cité", () => {
    const mixte = `${BLOC_WEB}

---

- [document doc_charte, fragment 3, score 0.62]
La charte impose 25 jours de congés payés annuels et un télétravail maximum de 3 jours par semaine.`;
    const composition = composerDepuisConnaissances(
      "cherche sur le web les dernières actualités intelligence artificielle",
      mixte,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("recherche web temps réel gen3ia");
    expect(composition!.texte).toContain("exemple-actu.com");
  });
});
