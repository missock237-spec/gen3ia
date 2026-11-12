import { beforeEach, describe, expect, it } from "vitest";

import { empreinte128 } from "@/lib/neural/generation/memoire-domaines";

import {
  configurerDepotMemoireUtilisateur,
  consulterMemoireUtilisateur,
  invaliderCacheMemoireUtilisateur,
  MemoireDomaineUtilisateur,
  MAX_OCTETS_UNITES_MEMOIRE,
  MAX_UNITES_PAR_MEMOIRE,
  memoireDepuisDocument,
  scoreAppariementUnite,
  slugifierDomaine,
  ingererUnitesDansMemoireUtilisateur,
  type DepotMemoireUtilisateur,
  type DocumentMemoireDomaine,
} from "./memoire-utilisateur";
import type { UniteConnaissance } from "./extraction-corpus";

/* ------------------------------------------------------------------ */
/* MÉMOIRE DE DOMAINE PAR UTILISATEUR — même contrat que memoire-       */
/* domaines (identifieDomaine / repondreIngestion), dédup par empreinte, */
/* plafonds honnêtes, persistance injectable (dépôt en mémoire ici).    */
/* ------------------------------------------------------------------ */

function unite(parametres: {
  question: string;
  contenu: string;
  type?: UniteConnaissance["type"];
  domaineSource?: string;
}): UniteConnaissance {
  return {
    empreinte: empreinte128(`${parametres.question}\n${parametres.contenu}`),
    type: parametres.type ?? "qa",
    question: parametres.question,
    contenu: parametres.contenu,
    motscles: [...new Set([
      ...parametres.contenu.toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿñæœ0-9_]+/),
      ...parametres.question.toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿñæœ0-9_]+/),
    ].filter((m) => m.length > 2))],
    source: { ressource: parametres.domaineSource ?? "fiche", origine: "texte" },
    octets: Buffer.byteLength(parametres.contenu, "utf-8"),
  };
}

const PHOTOSYNTHESE = unite({
  question: "Qu'est-ce que la photosynthèse ?",
  contenu:
    "Le processus par lequel les plantes vertes transforment la lumière du soleil en énergie chimique, en absorbant le dioxyde de carbone.",
});

const CHLOROPLASTES = unite({
  question: "Où se déroule la photosynthèse ?",
  contenu: "Dans les chloroplastes, les organites verts de la cellule végétale.",
});

/** Dépôt en mémoire (tests) — même interface que le dépôt R2 réel :
 * scoping PAR UID respecté (un compte ne lit jamais les documents d'un autre). */
function depotMemoire() {
  const documents = new Map<string, DocumentMemoireDomaine>();
  const depot: DepotMemoireUtilisateur = {
    async lireTous(uid) {
      return [...documents.values()].filter((d) => d.uid === uid);
    },
    async lire(uid, domaine) {
      const doc = documents.get(domaine);
      return doc && doc.uid === uid ? doc : null;
    },
    async ecrire(_uid, doc) {
      documents.set(doc.domaine, doc);
    },
  };
  return { depot, documents };
}

describe("MemoireDomaineUtilisateur — consultation", () => {
  const memoire = new MemoireDomaineUtilisateur([PHOTOSYNTHESE, CHLOROPLASTES]);

  it("répond exactement sur la question canonique de l'unité", () => {
    const reponse = memoire.repondre("Qu'est-ce que la photosynthèse ?");
    expect(reponse).not.toBeNull();
    expect(reponse?.texte).toBe(PHOTOSYNTHESE.contenu);
    expect(reponse?.score).toBeGreaterThan(0.5);
  });

  it("répond sur une reformulation raisonnable (recouvrement de mots-clés)", () => {
    const reponse = memoire.repondre("Comment fonctionne la photosynthèse ?");
    expect(reponse).not.toBeNull();
    expect(reponse?.texte).toBe(PHOTOSYNTHESE.contenu);
  });

  it("ne répond PAS à une question sans rapport (contrôle hors domaine)", () => {
    expect(memoire.repondre("Quelle est la capitale du Pérou ?")).toBeNull();
    expect(memoire.repondre("Recommande-moi un film de science-fiction.")).toBeNull();
    expect(memoire.repondre("")).toBeNull();
  });

  it("déduplique par empreinte et rend compte des compteurs", () => {
    const resultat = memoire.ingere([PHOTOSYNTHESE, unite({ question: "Nouvelle question du domaine ?", contenu: "Une nouvelle réponse suffisamment longue pour être retenue par la mémoire." })]);
    expect(resultat.unitesAjoutees).toBe(1);
    expect(resultat.doublons).toBe(1);
    expect(resultat.totalUnites).toBe(3);
  });

  it("applique les plafonds honnêtes (nombre + octets) avec compteurs explicites", () => {
    const petite = new MemoireDomaineUtilisateur([]);
    const charge = Array.from({ length: MAX_UNITES_PAR_MEMOIRE + 5 }, (_, i) =>
      unite({ question: `Question de charge numéro ${i} du domaine ?`, contenu: `Réponse de charge ${i} suffisamment longue pour être acceptée par la mémoire du compte.` }),
    );
    const resultat = petite.ingere(charge);
    expect(resultat.unitesAjoutees).toBe(MAX_UNITES_PAR_MEMOIRE);
    expect(resultat.refuseesCap).toBe(5);

    const grosse = new MemoireDomaineUtilisateur([]);
    const enorme = unite({
      question: "Question énorme sur le domaine ?",
      contenu: "x".repeat(MAX_OCTETS_UNITES_MEMOIRE + 10),
    });
    const resultatOctets = grosse.ingere([enorme]);
    expect(resultatOctets.unitesAjoutees).toBe(0);
    expect(resultatOctets.refuseesCap).toBe(1);
  });
});

describe("MemoireDomaineUtilisateur — contrat memoire-domaines (typage en canard)", () => {
  it("repondreIngestion : Jaccard de question seul, seuil 0.34 (parité)", () => {
    const memoire = new MemoireDomaineUtilisateur([PHOTOSYNTHESE]);
    expect(memoire.repondreIngestion("Qu'est-ce que la photosynthèse ?")).toBe(PHOTOSYNTHESE.contenu);
    // Reformulation avec recouvrement faible → refus honnête (seuil parité).
    expect(memoire.repondreIngestion("Comment fonctionne la photosynthèse ?")).toBeNull();
    expect(memoire.repondreIngestion("Question sans aucun rapport avec le corpus ?")).toBeNull();
  });

  it("identifieDomaine délègue l'heuristique Gen3", () => {
    const memoire = new MemoireDomaineUtilisateur([]);
    expect(memoire.identifieDomaine("Calcule l'aire d'un triangle rectangle")).toBe("math");
    expect(memoire.identifieDomaine("Réponds à une question sans aucun mot-clé de domaine connu")).toBeNull();
  });

  it("statistiques rend compte des types réels", () => {
    const memoire = new MemoireDomaineUtilisateur([
      PHOTOSYNTHESE,
      unite({ question: "Montre le calcul de la surface foliaire ?", contenu: "surface = longueur x largeur du limbe, mesurée en centimètres carrés.", type: "code" }),
    ]);
    const stats = memoire.statistiques();
    expect(stats.unites).toBe(2);
    expect(stats.parType.qa).toBe(1);
    expect(stats.parType.code).toBe(1);
    expect(stats.octets).toBeGreaterThan(0);
  });
});

describe("score d'appariement", () => {
  it("vaut ~1 sur la question exacte et 0 sur une question sans rapport", () => {
    expect(scoreAppariementUnite(PHOTOSYNTHESE.question, PHOTOSYNTHESE)).toBeGreaterThan(0.8);
    expect(scoreAppariementUnite("Capitale du Pérou ?", PHOTOSYNTHESE)).toBe(0);
  });
});

describe("persistance injectable + ingestion persistée", () => {
  beforeEach(() => {
    invaliderCacheMemoireUtilisateur();
  });

  it("ingererUnitesDansMemoireUtilisateur écrit le document et recharge", async () => {
    const { depot, documents } = depotMemoire();
    configurerDepotMemoireUtilisateur(depot);
    const resultat = await ingererUnitesDansMemoireUtilisateur("user-a", "botanique", [PHOTOSYNTHESE, CHLOROPLASTES]);
    expect(resultat.unitesAjoutees).toBe(2);
    const doc = documents.get("botanique");
    expect(doc).not.toBeNull();
    expect(doc?.v).toBe(1);
    expect(doc?.uid).toBe("user-a");
    expect(doc?.unites).toHaveLength(2);

    // Re-ingestion : tout est doublon, rien n'est réécrit.
    const reprise = await ingererUnitesDansMemoireUtilisateur("user-a", "botanique", [PHOTOSYNTHESE]);
    expect(reprise.unitesAjoutees).toBe(0);
    expect(reprise.doublons).toBe(1);
    expect(documents.get("botanique")?.unites).toHaveLength(2);
  });

  it("l'ingestion est isolée PAR UTILISATEUR (domaines distincts)", async () => {
    const { depot } = depotMemoire();
    configurerDepotMemoireUtilisateur(depot);
    await ingererUnitesDansMemoireUtilisateur("user-a", "botanique", [PHOTOSYNTHESE]);
    await ingererUnitesDansMemoireUtilisateur(
      "user-b",
      "astronomie",
      [unite({ question: "Qu'est-ce qu'une galaxie spirale ?", contenu: "Une galaxie spirale est un type de galaxie aux bras enroulés autour d'un centre lumineux." })],
    );
    const memoireA = memoireDepuisDocument(await depot.lire("user-a", "botanique"));
    const memoireB = memoireDepuisDocument(await depot.lire("user-b", "astronomie"));
    expect(memoireA.unitesConnues()).toHaveLength(1);
    expect(memoireB.unitesConnues()).toHaveLength(1);
    // Chaque compte répond depuis SA connaissance uniquement.
    expect(memoireA.repondre("Qu'est-ce que la photosynthèse ?")?.texte).toBe(PHOTOSYNTHESE.contenu);
    expect(memoireB.repondre("Qu'est-ce que la photosynthèse ?")).toBeNull();
    expect(memoireB.repondre("Qu'est-ce qu'une galaxie spirale ?")).not.toBeNull();
  });

  it("consulterMemoireUtilisateur répond depuis le compte et dégrade en null", async () => {
    const { depot } = depotMemoire();
    configurerDepotMemoireUtilisateur(depot);
    await ingererUnitesDansMemoireUtilisateur("user-a", "botanique", [PHOTOSYNTHESE]);

    const reponse = await consulterMemoireUtilisateur("Qu'est-ce que la photosynthèse ?", "user-a");
    expect(reponse).not.toBeNull();
    expect(reponse?.texte).toBe(PHOTOSYNTHESE.contenu);
    expect(reponse?.theme).toBe("studio:botanique");
    expect(reponse?.score).toBeGreaterThan(0.5);

    // Autre compte sans mémoire entraînée : null.
    expect(await consulterMemoireUtilisateur("Qu'est-ce que la photosynthèse ?", "user-sans-memoire")).toBeNull();
    // Message vide : null.
    expect(await consulterMemoireUtilisateur("   ", "user-a")).toBeNull();
  });

  it("le cache process sert la mémoire sans relecture du dépôt, invalidé à l'ingestion", async () => {
    const { depot, documents } = depotMemoire();
    let lectures = 0;
    const depotComptant: DepotMemoireUtilisateur = {
      lireTous: async () => {
        lectures += 1;
        return depot.lireTous("user-a");
      },
      lire: depot.lire,
      ecrire: depot.ecrire,
    };
    configurerDepotMemoireUtilisateur(depotComptant);
    await ingererUnitesDansMemoireUtilisateur("user-a", "botanique", [PHOTOSYNTHESE]);
    // Premier appel : charge et met en cache (1 lecture du dépôt).
    await consulterMemoireUtilisateur("Question de chat du domaine ?", "user-a");
    const avant = lectures;
    // Appels suivants : cache process (aucune relecture R2).
    await consulterMemoireUtilisateur("Autre question de chat ?", "user-a");
    expect(lectures).toBe(avant); // cache process (aucune relecture R2)

    // Nouvelle ingestion → cache invalidé → la consultation voit la nouvelle unité.
    await ingererUnitesDansMemoireUtilisateur("user-a", "botanique", [
      unite({ question: "Question fraîchement entraînée du domaine ?", contenu: "La toute nouvelle connaissance fraîchement ingérée dans la mémoire du compte." }),
    ]);
    const reponse = await consulterMemoireUtilisateur("Question fraîchement entraînée du domaine ?", "user-a");
    expect(reponse?.texte).toContain("fraîchement ingérée");
    expect(documents.get("botanique")?.unites).toHaveLength(2);
  });

  it("slugifie le domaine en segment de clé sûr", () => {
    expect(slugifierDomaine("Botanique tropicale !")).toBe("botanique-tropicale");
    expect(slugifierDomaine("Génétique & ADN")).toBe("genetique-adn");
    expect(slugifierDomaine("")).toBe("domaine");
    expect(slugifierDomaine("X".repeat(100))).toHaveLength(40);
  });
});
