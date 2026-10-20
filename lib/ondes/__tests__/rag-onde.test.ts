import { describe, expect, it } from "vitest";

import {
  construireIndexOndes,
  indexerDocument,
  extrairePhrases,
  repondreAvecAncrage,
  rechercherParResonance,
  REPONSE_ABSENCE,
} from "../rag-onde";

const GEO = "La capitale de la France est Paris. Paris compte environ deux millions d'habitants intramuros. Le climat parisien est tempéré océanique.";
const TECH = "Le protocole WebRTC établit des canaux de données directs entre navigateurs. La signalisation sert uniquement à établir la connexion entre pairs.";

const INDEX = construireIndexOndes("corpus-test", [
  { nom: "geo.txt", texte: GEO },
  { nom: "tech.txt", texte: TECH },
]);

describe("RAG à résonance d'ondes — indexation", () => {
  it("découpe un document court en un fragment, un long en plusieurs", () => {
    // Court (< 400 caractères) : les phrases se FUSIONNENT (contexte riche).
    expect(extrairePhrases(GEO)).toHaveLength(1);
    // Long : tranché par phrases, jamais au milieu d'un mot.
    const long = Array.from({ length: 12 }, (_, i) => `Phrase numéro ${i + 1} porte sur la physique des ondes de Kuramoto et la résonance.`).join(" ");
    const fragments = extrairePhrases(long);
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    for (const f of fragments) {
      expect(f.length).toBeGreaterThan(0);
      expect(f.length).toBeLessThanOrEqual(400);
    }
  });

  it("indexe chaque fragment avec son onde (vecteur + empreinte)", () => {
    const entrees = indexerDocument("geo.txt", GEO);
    expect(entrees.length).toBeGreaterThan(0);
    for (const e of entrees) {
      expect(e.source).toBe("geo.txt");
      expect(e.texte).toBeTruthy();
      expect(e.vecteur.length).toBe(1024);
      expect(e.empreinteOnde).toMatch(/^[0-9a-f]{8}$/);
      // Le vecteur porte du signal (au moins une composante non nulle).
      expect(Array.from(e.vecteur).some((x) => x !== 0)).toBe(true);
    }
  });

  it("l'empreinte d'onde est stable et sensible au contenu", () => {
    const a = indexerDocument("d.txt", GEO);
    const b = indexerDocument("d.txt", GEO);
    const c = indexerDocument("d.txt", TECH);
    expect(a.map((x) => x.empreinteOnde)).toEqual(b.map((x) => x.empreinteOnde));
    expect(a.map((x) => x.empreinteOnde)).not.toEqual(c.map((x) => x.empreinteOnde));
  });

  it("construit l'index complet d'un corpus", () => {
    expect(INDEX.nom).toBe("corpus-test");
    // Un fragment par document (documents courts fusionnés par phrase).
    expect(INDEX.entrees.length).toBeGreaterThanOrEqual(2);
    expect(INDEX.creeLe).toBeGreaterThan(0);
  });
});

describe("RAG à résonance d'ondes — recherche par résonance", () => {
  it("trouve une résonance constructive et cite la PHRASE EXACTE", () => {
    const resultat = rechercherParResonance("Quelle est la capitale de la France ?", INDEX);
    expect(resultat.resonance).toBe(true);
    expect(resultat.phraseExacte).toBeTruthy();
    // La citation fait partie du document — jamais reformulée.
    expect(GEO).toContain(resultat.phraseExacte!.trim());
    expect(resultat.source).toBe("geo.txt");
    expect(resultat.mesures?.reward).toBeGreaterThan(0);
  });

  it("ne trouve AUCUNE résonance pour une question hors corpus", () => {
    const resultat = rechercherParResonance("Comment préparer une sauce béchamel sans grumeaux ?", INDEX);
    expect(resultat.resonance).toBe(false);
    expect(resultat.phraseExacte).toBeNull();
    expect(resultat.source).toBeNull();
  });

  it("répond avec ancrage : citation exacte ou refus honnête — RIEN d'autre", () => {
    const trouve = repondreAvecAncrage("Quelle est la capitale de la France ?", INDEX);
    expect(trouve.absenceForcee).toBe(false);
    expect(trouve.reponse).toContain("geo.txt");
    expect(trouve.reponse).toContain("La capitale de la France est Paris");

    const absent = repondreAvecAncrage("Quel est le prix du billet de métro à Tokyo ?", INDEX);
    expect(absent.absenceForcee).toBe(true);
    expect(absent.reponse).toBe(REPONSE_ABSENCE);
  });

  it("l'anti-hallucination est STRUCTURELLE : aucune génération libre possible", () => {
    // Toutes les questions, même ambiguës ou provocatrices, aboutissent à
    // l'un des DEUX seuls textes possibles : une citation ou le refus.
    for (const question of [
      "Invente-moi une histoire sur les dragons de Paris",
      "Quelle heure est-il sur la lune ?",
      "Réponds n'importe quoi",
      "",
    ]) {
      const reponse = repondreAvecAncrage(question, INDEX);
      const estCitation = reponse.ancre.resonance && reponse.ancre.phraseExacte !== null;
      if (estCitation) {
        expect(GEO).toContain(reponse.reponse.replace("[geo.txt] ", "").trim());
        expect(TECH).toContain(reponse.reponse.replace("[tech.txt] ", "").trim());
      } else {
        expect(reponse.reponse).toBe(REPONSE_ABSENCE);
      }
    }
  });

  it("index vide ou question vide → pas de résonance", () => {
    const vide = construireIndexOndes("vide", []);
    expect(rechercherParResonance("Quelle est la capitale de la France ?", vide).resonance).toBe(false);
    expect(rechercherParResonance("", INDEX).resonance).toBe(false);
  });
});
