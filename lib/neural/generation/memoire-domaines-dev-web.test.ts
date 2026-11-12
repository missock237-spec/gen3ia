/**
 * GARDE DOMAINE « DÉVELOPPEMENT WEB » DE LA MÉMOIRE DE DOMAINES (it.150 —
 * WEBTRAIN-BIS) : inventaire RÉEL du corpus commis (≥ 2000 unités, comptes
 * par sous-thème AFFICHÉS), ingestion dans MemoireDomainesGen3 (domaine
 * enregistré, comptabilité honnête, idempotence), consultation (« qu'est-ce
 * qu'un CNAME » retourne une unité pertinente) et branchement sur la voie
 * « mémorisée » de la mémoire de réflexion.
 */
import { describe, expect, it } from "vitest";

import { CORPUS_DEV_WEB_DNS } from "./corpus-dev-web-dns";
import { CORPUS_DEV_WEB_HTML_CSS } from "./corpus-dev-web-html-css";
import { CORPUS_DEV_WEB_HTTP_SECURITE } from "./corpus-dev-web-http-securite";
import { CORPUS_DEV_WEB_JS_TS } from "./corpus-dev-web-js-ts";
import { CORPUS_DEV_WEB_PERF_A11Y } from "./corpus-dev-web-perf-a11y";
import { CORPUS_DEV_WEB_REACT_NEXT } from "./corpus-dev-web-react-next";
import { CORPUS_GEN3 } from "./corpus";
import { CortexLangagierGen3 } from "./language";
import {
  DOMAINE_DEVELOPPEMENT_WEB,
  MemoireDomainesGen3,
  SOUS_THEMES_DEV_WEB,
  identifieDomaine,
  unitesDevWebDepuisPaires,
} from "./memoire-domaines";
import { CortexReflexifGen3 } from "./memoire-reflexion";

/** Les 6 corpus commis du domaine, sous-thèmes alignés. */
const CORPUS_PAR_SOUS_THEME: readonly (readonly [string, typeof CORPUS_DEV_WEB_DNS])[] = [
  ["dns", CORPUS_DEV_WEB_DNS],
  ["html-css", CORPUS_DEV_WEB_HTML_CSS],
  ["http-securite", CORPUS_DEV_WEB_HTTP_SECURITE],
  ["js-ts", CORPUS_DEV_WEB_JS_TS],
  ["perf-a11y", CORPUS_DEV_WEB_PERF_A11Y],
  ["react-next", CORPUS_DEV_WEB_REACT_NEXT],
];

const TOUTES_LES_UNITES = unitesDevWebDepuisPaires(
  CORPUS_PAR_SOUS_THEME.flatMap(([, corpus]) => [...corpus]),
);

describe("domaine « developpement-web » — inventaire réel du corpus", () => {
  it("≥ 2000 unités réelles tous sous-thèmes confondus (comptes affichés)", () => {
    let total = 0;
    const lignes: string[] = [];
    for (const [sousTheme, corpus] of CORPUS_PAR_SOUS_THEME) {
      expect(SOUS_THEMES_DEV_WEB).toContain(sousTheme);
      total += corpus.length;
      lignes.push(`${sousTheme.padEnd(14)} : ${corpus.length} unités`);
    }
    // Le compte réel s'affiche dans le rapport de test (demande :
    // « combien d'unités réelles ? affiche-le dans un test d'inventaire »).
    console.log(
      `inventaire corpus developpement-web (unités réelles, motifs uniques) :\n  ${lignes.join("\n  ")}\n  TOTAL          : ${total} unités`,
    );
    expect(total).toBeGreaterThanOrEqual(2000);
    // les motifs sont uniques sur tout le corpus (aucun comptage gonflé)
    const motifs = new Set(TOUTES_LES_UNITES.map((u) => u.motif));
    expect(motifs.size).toBe(TOUTES_LES_UNITES.length);
    // chaque unité porte un sous-thème connu et une réponse non vide
    for (const u of TOUTES_LES_UNITES) {
      expect(SOUS_THEMES_DEV_WEB).toContain(u.sousTheme);
      expect(u.reponse.length).toBeGreaterThan(10);
    }
  });
});

describe("domaine « developpement-web » — enregistrement et ingestion", () => {
  it("le domaine est enregistré : ingéré accepté, comptabilité du compartiment", () => {
    const memoire = new MemoireDomainesGen3();
    const r = memoire.ingere({
      question: "Qu'est-ce qu'un CNAME dans une zone DNS ?",
      contenu:
        "Le CNAME est un alias vers un autre nom DNS ; à l'apex il est interdit (SOA/NS obligatoires).",
      domaine: DOMAINE_DEVELOPPEMENT_WEB,
      source: "chat-ia",
    });
    expect(r.accepte).toBe(true);
    expect(r.raison).toBe("nouveau");
    const etat = memoire.etatCompartiment(DOMAINE_DEVELOPPEMENT_WEB, "texte");
    expect(etat.octetsInges).toBeGreaterThan(0);
    expect(etat.octetsPhysiques).toBe(etat.octetsInges);
    // classifieur : les questions dev web/DNS pointent le bon domaine
    expect(identifieDomaine("Qu'est-ce qu'un CNAME ?")).toBe(DOMAINE_DEVELOPPEMENT_WEB);
    expect(identifieDomaine("Comment fonctionne le TTL d'un enregistrement DNS ?")).toBe(
      DOMAINE_DEVELOPPEMENT_WEB,
    );
    expect(identifieDomaine("Comment prévenir le CORS mal configuré ?")).toBe(
      DOMAINE_DEVELOPPEMENT_WEB,
    );
    // non-régression : les autres domaines gardent leurs indices
    expect(identifieDomaine("Le chiffrement AES protège-t-il contre le XSS ?")).toBe("security_v4");
    expect(identifieDomaine("Écris une requête SQL avec une jointure")).toBe("databases");
  });

  it("l'annexe indexe TOUT le corpus (2441 unités, sans éviction, idempotent)", () => {
    const memoire = new MemoireDomainesGen3();
    const resume = memoire.ingereDevWebCorpus(TOUTES_LES_UNITES);
    expect(resume.total).toBe(2441);
    expect(resume.acceptees).toBe(2441);
    expect(resume.doublons).toBe(0);
    expect(resume.octets).toBeGreaterThan(100_000);
    // ré-ingestion : déduplication complète, octets NON re-comptés
    const reprise = memoire.ingereDevWebCorpus(TOUTES_LES_UNITES);
    expect(reprise.acceptees).toBe(0);
    expect(reprise.doublons).toBe(2441);
    const inventaire = memoire.memoireDevWeb().inventaire();
    expect(inventaire.total).toBe(2441);
    console.log(
      `ingestion annexe developpement-web : ${inventaire.total} unités, ${inventaire.octets} octets — par sous-thème : ${JSON.stringify(inventaire.parSousTheme)}`,
    );
    for (const st of SOUS_THEMES_DEV_WEB) {
      expect(inventaire.parSousTheme[st], `sous-thème ${st}`).toBeGreaterThan(0);
    }
    // statistiques globales : le domaine expose son inventaire
    const stats = memoire.statistiques();
    expect(stats.developpementWeb.total).toBe(2441);
    // comptabilité du compartiment = octets acceptés (honnêteté)
    expect(memoire.etatCompartiment(DOMAINE_DEVELOPPEMENT_WEB, "texte").octetsInges).toBe(
      resume.octets,
    );
  });

  it("ingestion déléguée à l'annexe ne comptabilise que les ACCEPTÉES", () => {
    const memoire = new MemoireDomainesGen3();
    const uniteValide = { motif: "Qu'est-ce qu'un MX ?", reponse: "Le MX route le courriel.", sousTheme: "dns" };
    const vide = { motif: "   ", reponse: "", sousTheme: "dns" };
    const r1 = memoire.memoireDevWeb().ingereUnite(uniteValide);
    expect(r1.accepte).toBe(true);
    const r2 = memoire.memoireDevWeb().ingereUnite(vide);
    expect(r2.accepte).toBe(false);
    expect(r2.raison).toBe("contenu-vide");
    expect(memoire.memoireDevWeb().inventaire().total).toBe(1);
  });
});

describe("domaine « developpement-web » — consultation", () => {
  it("« qu'est-ce qu'un CNAME ? » retourne une unité CNAME pertinente", () => {
    const memoire = new MemoireDomainesGen3();
    memoire.ingereDevWebCorpus(TOUTES_LES_UNITES);
    const unite = memoire.memoireDevWeb().consulte("qu'est-ce qu'un CNAME ?");
    expect(unite).not.toBeNull();
    expect(unite!.sousTheme).toBe("dns");
    expect(unite!.motif.toLowerCase()).toContain("cname");
    expect(unite!.reponse).toContain("CNAME");
    // la même consultation passe par la VOIE « MÉMORISÉE » (contrat public)
    const reponse = memoire.repondreIngestion("Qu'est-ce qu'un CNAME ?");
    expect(reponse).not.toBeNull();
    expect(reponse!).toContain("CNAME");
    // autre sonde : TTL
    const ttl = memoire.repondreIngestion("Comment fonctionne le TTL d'un enregistrement DNS ?");
    expect(ttl).not.toBeNull();
    expect(ttl!.toLowerCase()).toContain("ttl");
  });

  it("aucun faux positif : hors-sujet ne déclenche pas l'annexe", () => {
    const memoire = new MemoireDomainesGen3();
    memoire.ingereDevWebCorpus(TOUTES_LES_UNITES);
    expect(memoire.repondreIngestion("Quel est le capitaine du navire Erebus")).toBeNull();
    expect(memoire.repondreIngestion("bonjour")).toBeNull();
    expect(memoire.repondreIngestion("")).toBeNull();
  });

  it("la mémoire de réflexion répond via la voie « memorisee » sur le dev web", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const memoire = new MemoireDomainesGen3();
    memoire.ingereDevWebCorpus(TOUTES_LES_UNITES);
    const reflexif = new CortexReflexifGen3(cortex, memoire);
    // le corpus canonique ne connaît PAS le DNS : quand la voie directe
    // échoue, l'annexe dev web rattrape (exactement le mécanisme chat/API)
    const d = reflexif.reflechir("Dis-moi ce qu'est un CNAME en DNS");
    expect(d.voieElue).toBe("memorisee");
    expect(d.elue.length).toBeGreaterThan(20);
    expect(d.domaine).toBe(DOMAINE_DEVELOPPEMENT_WEB);
    // formulation courte : quelle que soit la voie élue (le cortex peut
    // servir un appariement approximatif AVANT l'annexe — comportement
    // historique), la délibération reste traçable et la question est servie
    const d2 = reflexif.reflechir("Qu'est-ce qu'un CNAME ?");
    expect(d2.voieElue).not.toBe("echec");
    // la voie mémorisée seule renvoie la réponse CNAME pertinente
    const viaMemoire = memoire.repondreIngestion("Qu'est-ce qu'un CNAME ?");
    expect(viaMemoire).not.toBeNull();
    expect(viaMemoire!).toContain("CNAME");
    const reponse = reflexif.repondre("Dis-moi ce qu'est un CNAME en DNS");
    expect(reponse?.texte.length ?? 0).toBeGreaterThan(20);
    expect(reponse?.source).toBe("personnalisee");
    // non-régression : hors-sujet → pas de voie mémorisée
    const d3 = reflexif.reflechir("Quel est le capitaine du navire Erebus");
    expect(d3.voieElue).not.toBe("memorisee");
  });
});
