/**
 * GARDE PASSERELLE DE TESTS DE PRODUCTION DEV WEB (it.150 — WEBTRAIN-BIS) :
 * exécution des 10 tests de production contre un répondeur async, rapport
 * { tests, tauxAcquisition } au format demandé pour la sonde Python.
 */
import { describe, expect, it } from "vitest";

import {
  IDS_TEST_PRODUCTION_DEV_WEB,
  QUESTIONS_TEST_PRODUCTION_DEV_WEB,
} from "./dev-web-eval";
import {
  executerTestsProductionDevWeb,
  type RepondeurDevWeb,
} from "./passerelle-production";

/** Répondeur « expert » : chaque prompt est servi par sa référence couvrant
 * les points clés (réponses volontairement reformulées — le grader est
 * lexical et pondéré, pas un appariement de chaînes). */
const REFERENCES: Record<string, string> = {
  "html-semantique":
    "Le HTML sémantique porte la SIGNIFICATION : header, nav, main, article, section, aside, footer structurent la page et servent de landmarks au lecteur d'écran et aux moteurs (SEO) ; un div ne dit rien. Un seul h1, hiérarchie de titres ordonnée. Un button déclenche une action, un lien (a) navigue.",
  "flex-grid":
    "Flex = un axe (flex-direction row/column), Grid = deux dimensions (lignes ET colonnes) ; justify-content règle l'axe principal, align-items le secondaire. Centrer : display: flex, justify-content: center, align-items: center. Grille responsive : grid-template-columns avec repeat et minmax (auto-fit) ; gap espace.",
  "async-await":
    "async/await s'appuie sur les promesses (promise) : la fonction async renvoie toujours une promesse, await attend la résolution ; le code reste lisible face aux callbacks et aux .then ; les erreurs passent au try/catch ; Promise.all exécute en parallèle (parallélisme).",
  "ts-generics":
    "Les génériques paramètrent un type (paramètre de type) : <T> se spécialise à l'usage, code réutilisable sans dupliquer, sécurité du typage conservée (évite any). Exemple : identite<T>(v: T): T. Contrainte : T extends { id: string }. Utilitaires : Partial, Record.",
  "http-304-etag":
    "L'ETag identifie la version de la ressource ; le client revalide par If-None-Match — inchangé, le serveur renvoie 304 Not Modified sans corps : le cache client garde sa copie (économie de bande passante). Variantes : If-Modified-Since / Last-Modified ; fraîcheur par Cache-Control max-age.",
  "cors-preflight":
    "Le navigateur applique la politique de même origine ; CORS l'assouplit : Access-Control-Allow-Origin autorise l'origine. Requête non simple (méthode, en-têtes personnalisés) → preflight OPTIONS préalable ; le serveur répond Access-Control-Allow-Methods / Access-Control-Allow-Headers et Access-Control-Max-Age met le preflight en cache.",
  "dns-mx-ttl":
    "MX route le courriel vers le serveur mail : priorité la plus petite d'abord, essais croissants, priorités égales répartissent. Le TTL (secondes) borne la durée en cache : court = changements rapides, long = moins de charge ; le résolveur décrémente le TTL des réponses en cache et la propagation est l'expiration de ces caches.",
  "dns-cname-apex":
    "Un CNAME est un alias vers un autre nom ; à l'apex il est interdit : le sommet doit porter SOA et NS et un nom avec CNAME ne peut porter aucun autre enregistrement (RFC 1034/2181). Alternatives : A/AAAA directs, ALIAS/ANAME, flattening. Sous un sous-domaine (www), le CNAME reste légal.",
  "dns-propagation":
    "La propagation n'est PAS une onde : les caches expirent à leur TTL. Avant une migration on baisse le TTL 24–48 h à l'avance ; ensuite on vérifie l'autoritaire (dig @ns) puis on compare des résolveurs publics (8.8.8.8, 1.1.1.1). Le TTL négatif du SOA cadence l'expiration d'un NXDOMAIN.",
  "dnssec-pourquoi":
    "DNSSEC signe les RRsets : signature cryptographique qui prouve authenticité et intégrité — contre le cache poisoning (Kaminsky) et le détournement. Il ne chiffre pas (confidentialité : DoH/DoT). La chaîne de confiance racine→TLD→zone repose sur DS/DNSKEY ; une zone invalide donne SERVFAIL.",
};

function repondeurExpert(question: string): string {
  const q = QUESTIONS_TEST_PRODUCTION_DEV_WEB.find((x) => x.prompt === question);
  return q ? (REFERENCES[q.id] ?? "") : "";
}

describe("passerelle-production — les 10 tests de production", () => {
  it("répondeur expert : 10 tests exécutés, tauxAcquisition = 1", async () => {
    const rapport = await executerTestsProductionDevWeb(repondeurExpert);
    expect(rapport.tests).toHaveLength(10);
    expect(rapport.ids).toEqual(IDS_TEST_PRODUCTION_DEV_WEB);
    expect(rapport.tauxAcquisition).toBe(1);
    expect(rapport.tauxPartielOuMieux).toBe(1);
    for (const t of rapport.tests) {
      expect(t.verdict, `${t.questionId} → ${t.score}`).toBe("acquis");
      expect(t.score).toBeGreaterThan(70);
      expect(t.pointsManquants).toHaveLength(0);
    }
    console.log(
      `rapport production : ${rapport.tests.map((t) => `${t.questionId}=${t.score}`).join(", ")} — tauxAcquisition ${rapport.tauxAcquisition}`,
    );
  });

  it("répondeur async : les promesses sont attendues", async () => {
    const rapport = await executerTestsProductionDevWeb(async (question) => {
      await Promise.resolve();
      return repondeurExpert(question);
    });
    expect(rapport.tauxAcquisition).toBe(1);
  });

  it("répondeur hors-sujet : tout est insuffisant, tauxAcquisition = 0", async () => {
    const rapport = await executerTestsProductionDevWeb(
      () => "J'aime beaucoup les gâteaux au chocolat de mamie.",
    );
    expect(rapport.tests).toHaveLength(10);
    expect(rapport.tauxAcquisition).toBe(0);
    expect(rapport.tauxPartielOuMieux).toBe(0);
    for (const t of rapport.tests) {
      expect(t.verdict).toBe("insuffisant");
      expect(t.score).toBeLessThan(30);
      expect(t.pointsManquants.length).toBeGreaterThan(0);
    }
  });

  it("répondeur muet (réponse vide/undefined) : score 0 sans panne", async () => {
    const rapport = await executerTestsProductionDevWeb(() => "");
    expect(rapport.tauxAcquisition).toBe(0);
    for (const t of rapport.tests) expect(t.score).toBe(0);
  });

  it("répondeur partiel : tauxAcquisition entre 0 et 1 (mesure graduée)", async () => {
    // ne répond correctement qu'aux questions DNS (4 sur 10) → 0.4 acquis
    const rapport = await executerTestsProductionDevWeb((question) => {
      const q = QUESTIONS_TEST_PRODUCTION_DEV_WEB.find((x) => x.prompt === question);
      if (!q) return "";
      return q.sousTheme === "dns" ? (REFERENCES[q.id] ?? "") : "je ne sais pas";
    });
    expect(rapport.tauxAcquisition).toBeCloseTo(0.4, 5);
  });

  it("le contrat de la sonde : chaque test porte questionId + score + verdict", async () => {
    const rapport = await executerTestsProductionDevWeb(repondeurExpert);
    for (const t of rapport.tests) {
      expect(typeof t.questionId).toBe("string");
      expect(typeof t.score).toBe("number");
      expect(["acquis", "partiel", "insuffisant"]).toContain(t.verdict);
    }
  });
});

describe("passerelle-production — garde de type du répondeur", () => {
  it("un répondeur sync est accepté par le contrat RepondeurDevWeb", async () => {
    const repondeur: RepondeurDevWeb = (question) => (question.length > 0 ? "peu importe" : "");
    const rapport = await executerTestsProductionDevWeb(repondeur);
    expect(rapport.tests).toHaveLength(10);
  });
});
