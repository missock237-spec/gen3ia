import { describe, expect, it } from "vitest";

import {
  certifierParConsensus,
  CollecteurConsensus,
  QUORUM_DEFAUT,
  type MessageConsensusReponse,
  type ReponseEssaim,
} from "../consensus-essaim";
import { attestationPourPaquet, executerDefi } from "../por";

const PARIS = "La capitale de la France est Paris, ville lumière.";
const PARIS_BIS = "La capitale de la France est Paris, la ville lumière.";
const CHAT = "Le chat domestique dort en moyenne seize heures par jour.";
const DRAGONS = "Les dragons crachent du feu et volent au-dessus des océans.";

const essai = (textes: string[]): ReponseEssaim[] =>
  textes.map((texte, i) => ({ noeudId: `n${i + 1}`, texte }));

describe("Proof-of-Consensus — jamais confiance à un seul nœud", () => {
  it("refuse de certifier avec moins de 3 réponses (quorum)", () => {
    const un = certifierParConsensus(essai([PARIS]));
    expect(un.verdict).toBe("insuffisant");
    expect(un.reponseCertifiee).toBeNull();

    const deux = certifierParConsensus(essai([PARIS, PARIS_BIS]));
    expect(deux.verdict).toBe("insuffisant");
    expect(deux.motif).toContain("Quorum");
  });

  it("certifie quand 3 ondes indépendantes résonnent ensemble", () => {
    const certification = certifierParConsensus(essai([PARIS, PARIS_BIS, "Paris est la capitale de la France."]));
    expect(certification.verdict).toBe("certifie");
    expect(certification.reponseCertifiee).toBeTruthy();
    expect(certification.quorum).toBe(3);
    expect(certification.coherenceMoyenne).toBeGreaterThan(0.2);
    expect(certification.paires.every((p) => p.constructive)).toBe(true);
  });

  it("annule l'hallucination déphasée par interférence destructive et certifie les 2 restants", () => {
    const certification = certifierParConsensus(essai([PARIS, PARIS_BIS, DRAGONS]));
    expect(certification.verdict).toBe("certifie");
    expect(certification.annules.map((a) => a.noeudId)).toContain("n3");
    expect(certification.reponseCertifiee).not.toContain("dragon");
    expect(certification.motif).toContain("annulée");
  });

  it("rejette quand aucune onde n'est en phase (plutôt qu'une réponse fausse)", () => {
    const certification = certifierParConsensus(essai([PARIS, CHAT, DRAGONS]));
    expect(certification.verdict).toBe("rejete");
    expect(certification.reponseCertifiee).toBeNull();
  });

  it("les réponses vides ne comptent pas dans le quorum (strictesse)", () => {
    const certification = certifierParConsensus(essai([PARIS, PARIS_BIS, "   "]));
    expect(certification.annules.map((a) => a.noeudId)).toContain("n3");
    // Une réponse vide n'est pas un calcul : 2 réponses valides < quorum 3.
    expect(certification.verdict).toBe("insuffisant");
    expect(certification.reponseCertifiee).toBeNull();
  });

  it("exclut avant vote un nœud dont la preuve PoR est invalide", () => {
    const attestationValide = attestationPourPaquet(executerDefi("defi-consensus-1"));
    const reponses: ReponseEssaim[] = [
      { noeudId: "honnete-1", texte: PARIS, por: attestationValide },
      { noeudId: "honnete-2", texte: PARIS_BIS, por: attestationValide },
      { noeudId: "tricheur", texte: CHAT, por: { ...attestationValide, g: 0 } }, // plausibilité impossible
      { noeudId: "honnete-3", texte: "Paris est la capitale de la France." },
    ];
    const certification = certifierParConsensus(reponses);
    expect(certification.exclusPor).toEqual(["tricheur"]);
    expect(certification.verdict).toBe("certifie");
    expect(certification.reponseCertifiee).not.toContain("chat");
  });

  it("l'exclusion PoR peut faire tomber sous le quorum", () => {
    const attestation = attestationPourPaquet(executerDefi("defi-consensus-2"));
    const reponses: ReponseEssaim[] = [
      { noeudId: "a", texte: PARIS, por: attestation },
      { noeudId: "b", texte: PARIS_BIS, por: { e: "courts" } as never },
      { noeudId: "c", texte: "Paris, capitale française.", por: { ...attestation, r: 0 } },
    ];
    const certification = certifierParConsensus(reponses);
    expect(certification.exclusPor).toEqual(["b", "c"]);
    expect(certification.verdict).toBe("insuffisant");
  });

  it("accepte un vérificateur PoR complet injectable (empreinte authentique)", () => {
    const empreinteValide = executerDefi("defi-consensus-3");
    const reponses: ReponseEssaim[] = [
      { noeudId: "a", texte: PARIS, por: empreinteValide },
      { noeudId: "b", texte: PARIS_BIS, por: empreinteValide },
      { noeudId: "c", texte: "Paris est la capitale de la France.", por: empreinteValide },
    ];
    const certification = certifierParConsensus(reponses, {
      verifierPor: (por) => por.empreinte === empreinteValide.empreinte,
    });
    expect(certification.verdict).toBe("certifie");

    const triche = certifierParConsensus(reponses, { verifierPor: () => false });
    expect(triche.exclusPor).toEqual(["a", "b", "c"]);
    expect(triche.verdict).toBe("insuffisant");
  });

  it("QUORUM_DEFAUT vaut 3 — configurable vers le haut", () => {
    expect(QUORUM_DEFAUT).toBe(3);
    const reponses = essai([PARIS, PARIS_BIS, "Paris est la capitale de la France.", CHAT]);
    const strict = certifierParConsensus(reponses, { quorum: 4 });
    expect(strict.quorumRequis).toBe(4);
    expect(strict.verdict).toBe("certifie"); // 3 ondes en phase ≥ 2, mais quorum affiché 4
    expect(strict.quorum).toBe(3);
  });
});

describe("CollecteurConsensus — collecte côté Master", () => {
  const question = { protocole: "consensus" as const, type: "question" as const, idQuestion: "q-42", question: "Complexité ?", ts: Date.now() };

  it("déduplique par nœud (la première réponse compte)", () => {
    const collecteur = new CollecteurConsensus(question, { timeoutMs: 10_000 });
    const reponse = (texte: string, noeudId = "n1"): MessageConsensusReponse => ({
      protocole: "consensus",
      type: "reponse",
      idQuestion: "q-42",
      noeudId,
      texte,
      ts: Date.now(),
    });
    expect(collecteur.recevoir(reponse("première"))).toBe(true);
    expect(collecteur.recevoir(reponse("deuxième"))).toBe(false);
    expect(collecteur.collecter()).toHaveLength(1);
    expect(collecteur.collecter()[0].texte).toBe("première");
  });

  it("ignore les messages d'une autre question ou d'un autre protocole", () => {
    const collecteur = new CollecteurConsensus(question, { timeoutMs: 10_000 });
    expect(
      collecteur.recevoir({ protocole: "consensus", type: "reponse", idQuestion: "q-AUTRE", noeudId: "n1", texte: "x", ts: Date.now() }),
    ).toBe(false);
    expect(collecteur.nbReponses).toBe(0);
  });

  it("prêt au quorum, expiré après le délai", () => {
    // timeoutMs négatif : la fenêtre est déjà expirée à la construction.
    const collecteur = new CollecteurConsensus(question, { timeoutMs: -1 });
    expect(collecteur.expire()).toBe(true);
    expect(
      collecteur.recevoir({ protocole: "consensus", type: "reponse", idQuestion: "q-42", noeudId: "n1", texte: "trop tard", ts: Date.now() }),
    ).toBe(false);
    const frais = new CollecteurConsensus(question, { timeoutMs: 10_000 });
    expect(frais.pret()).toBe(false);
    for (const noeudId of ["a", "b", "c"]) {
      frais.recevoir({ protocole: "consensus", type: "reponse", idQuestion: "q-42", noeudId, texte: "ok", ts: Date.now() });
    }
    expect(frais.pret()).toBe(true);
    expect(frais.nbReponses).toBe(3);
  });
});
