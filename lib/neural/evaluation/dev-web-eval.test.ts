/**
 * GARDE HARNAIS D'ÉVALUATION DÉVELOPPEMENT WEB + DNS (it.150 — WEBTRAIN-BIS) :
 * ≥ 30 questions graduées (31 réelles) dont les 10 tests de production aux
 * IDs demandés ; réponse correcte > 70 → « acquis », hors-sujet < 30 →
 * « insuffisant », réponse partielle → « partiel » ; chaque question de
 * production porte des points clés VÉRIFIABLES (mots attendus, poids,
 * déterminisme).
 */
import { describe, expect, it } from "vitest";

import {
  IDS_TEST_PRODUCTION_DEV_WEB,
  QUESTIONS_DEV_WEB,
  QUESTIONS_TEST_PRODUCTION_DEV_WEB,
  SEUIL_ACQUIS_DEV_WEB,
  SEUIL_INSUFFISANT_DEV_WEB,
  inventaireHarnaisDevWeb,
  normaliserTexteDevWeb,
  scorerReponseDevWeb,
} from "./dev-web-eval";

/** Réponses de référence (écrites pour couvrir les points clés attendus). */
const REPONSES_REFERENCE: Record<string, string> = {
  "html-semantique":
    "Le HTML sémantique donne du sens : les balises structurelles (header, nav, main, article, section, aside, footer) servent de landmarks au lecteur d'écran et aux moteurs de recherche (SEO) — un div ne dit rien. Un seul h1 par page, hiérarchie de titres sans saut de niveau. button pour déclencher une action, a (lien) pour naviguer.",
  "flex-grid":
    "Flexbox répartit sur un axe principal (flex-direction : row ou column) ; Grid gère deux dimensions, lignes et colonnes. Centrage : display: flex ; justify-content: center ; align-items: center. Grille responsive : grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)). Espacement : gap. Grid pour le squelette, flex dans les cellules.",
  "async-await":
    "Une fonction async renvoie toujours une promesse ; await suspend l'exécution jusqu'à la résolution, l'enchaînement est lisible par rapport aux callbacks imbriqués et aux .then chaînés. Les erreurs se gèrent avec try/catch. Parallélisme : Promise.all.",
  "ts-generics":
    "Les génériques paramètrent un type (paramètre de type <T>) qui se spécialise à l'usage : code réutilisable sans dupliquer, avec la sécurité du typage (évite any). Exemple : function identite<T>(valeur: T) { return valeur; }. Contrainte : T extends { id: string }. Utilitaires : Partial<T>, Record<string, T>.",
  "http-304-etag":
    "Le serveur associe à la ressource un ETag (identifiant opaque de sa version). Le client revalide avec If-None-Match : si la version est inchangée, le serveur répond 304 Not Modified sans corps — le cache client conserve sa copie, avec économie de bande passante. Variante par date : If-Modified-Since / Last-Modified ; fraîcheur directe avec Cache-Control: max-age.",
  "cors-preflight":
    "Sans CORS, la politique de même origine du navigateur bloque la lecture d'une réponse d'une autre origine (schéma + host + port). Le serveur autorise via Access-Control-Allow-Origin. Pour une requête non simple (PUT/DELETE, en-têtes personnalisés), le navigateur envoie d'abord un preflight OPTIONS ; le serveur répond Access-Control-Allow-Methods et Access-Control-Allow-Headers, et le preflight se met en cache (Access-Control-Max-Age).",
  "dns-mx-ttl":
    "MX désigne le serveur de courriel du domaine : priorité la plus petite d'abord, puis essais croissants ; les priorités égales répartissent la charge. Le TTL (en secondes) est la durée pendant laquelle une réponse peut être mise en cache : TTL court → changements visibles vite, TTL long → moins de charge autoritaire ; le résolveur décrémente le TTL des réponses en cache, et la propagation n'est que l'expiration de ces caches.",
  "dns-cname-apex":
    "CNAME est un alias vers un autre nom. À l'apex c'est interdit : le sommet du domaine doit porter SOA et NS, or un nom qui a un CNAME ne peut porter aucun autre enregistrement (RFC 1034 / 2181). Alternatives : A/AAAA directs, ALIAS/ANAME ou CNAME flattening chez l'hébergeur. Hors apex (ex. www), le CNAME est parfaitement légal.",
  "dns-propagation":
    "La « propagation » n'est pas une onde : ce sont les caches des résolveurs qui expirent à leur TTL. Avant une migration : baisser le TTL à 60–300 s 24–48 h à l'avance, attendre l'ancien TTL, changer, puis vérifier l'autoritaire (dig @ns) et comparer plusieurs résolveurs publics (8.8.8.8, 1.1.1.1). Le TTL négatif du SOA gouverne la fin d'un NXDOMAIN.",
  "dnssec-pourquoi":
    "DNSSEC signe cryptographiquement chaque RRset : le résolveur valideur prouve l'authenticité et l'intégrité de la réponse — cela tue le cache poisoning (Kaminsky) et le détournement sur le chemin. En revanche DNSSEC ne chiffre pas : la confidentialité du transport passe par DoH/DoT. La chaîne de confiance descend de la racine aux TLD puis à la zone via DS/DNSKEY ; une zone invalide devient SERVFAIL.",
  // ── références des 20 questions graduées (non production) ──
  "html-formulaires-accessibles":
    "Chaque champ porte un label relié par for (ou aria-labelledby), les groupes vont dans un fieldset avec legend, les erreurs sont annoncées (aria-invalid + aria-describedby), et le placeholder n'est PAS un label.",
  "html-alt-images":
    "L'alt décrit la fonction ou le contenu utile de l'image ; pour une image décorative, alt vide ; jamais « image de », c'est redondant.",
  "css-specificite":
    "La spécificité se compte (identifiants, classes/attributs, éléments) ; les styles inline passent devant ; !important inverse l'ordre (anti-pattern) ; @layer déclare des couches pour maîtriser l'ordre.",
  "js-tableaux-immuables":
    "map transforme chaque élément et retourne un nouveau tableau de même taille ; filter sélectionne un sous-ensemble ; reduce accumule vers une valeur unique — aucune ne mute le tableau d'origine (immuable).",
  "js-modules-esm":
    "export expose des liaisons (nommées ou default) ; import les consomme depuis un autre module ; le graph statique permet le tree-shaking.",
  "ts-utility-types":
    "Partial<T> rend les propriétés facultatives ; Record<K,V> construit un dictionnaire clé→type ; Readonly interdit la mutation ; ce sont des types mappés.",
  "react-hooks-etat":
    "useState porte l'état local et son setter ; useEffect synchronise des effets avec un tableau de dépendances ; les hooks s'appellent au sommet du composant, jamais dans des conditions.",
  "next-server-client-components":
    "Les composants serveur (RSC) sont le défaut de l'App Router ; \"use client\" délimite les composants interactifs (état, navigateur) ; un composant serveur ne peut pas porter useState ni d'effets.",
  "next-app-router-structure":
    "Chaque dossier est un segment de route (page.tsx), layout.tsx enveloppe ses segments et persiste, loading.tsx et error.tsx gèrent les conventions.",
  "next-data-fetching-cache":
    "Le fetch d'un composant serveur accepte cache et next.revalidate ; la revalidation se fait par temps (secondes) ou par tag ; les requêtes identiques sont dédupliquée (mémoïsée) par requête.",
  "http-401-vs-403":
    "401 Unauthorized : il faut s'authentifier (le serveur renvoie WWW-Authenticate) ; 403 Forbidden : le client est identifié mais le serveur refuse — l'authentification ne changera rien.",
  "http-404-vs-410":
    "404 : la ressource est introuvable (permanence non garantie) ; 410 Gone : définitivement supprimée — les moteurs la déindexent plus vite (SEO).",
  "http-methodes-idempotence":
    "GET et HEAD sont sûres (sans effet sur l'état) ; PUT et DELETE sont idempotentes (répétables), POST non ; PUT remplace complètement la ressource, PATCH la modifie partiellement.",
  "securite-csp-headers":
    "Content-Security-Policy borne les sources (script-src avec nonce) ; X-Content-Type-Options: nosniff empêche le reniflement ; CSP frame-ancestors (ou X-Frame-Options) bloque le clickjacking ; HSTS force HTTPS.",
  "perf-lcp":
    "Le LCP (Largest Contentful Paint) est bon ≤ 2.5 s ; précharger la ressource critique (preload) ; optimiser les images (formats modernes comme webp, tailles responsive).",
  "perf-cls":
    "Le CLS (Cumulative Layout Shift) est bon < 0.1 ; réserver la place avec width/height ou aspect-ratio ; ne pas insérer de contenu au-dessus du contenu existant.",
  "a11y-contraste-wcag":
    "Le WCAG AA exige 4.5:1 pour le texte normal et 3:1 pour le gros texte ; le AAA monte à 7:1.",
  "dns-a-aaaa":
    "A mappe un nom vers une adresse IPv4 (32 bits) ; AAAA vers une IPv6 (128 bits) ; on publie les deux en parallèle (dual-stack).",
  "dns-zone-soa-serial":
    "Le SOA ouvre la zone (NS primaire, contact) ; le serial doit être incrémenté à chaque modification, sinon les secondaires ne transfèrent pas la zone ; le champ minimum sert de TTL négatif pour les NXDOMAIN.",
  "dns-spf-dkim-dmarc":
    "SPF : un TXT v=spf1 avec include et -all ; DKIM : la clé publique au nom sélecteur._domainkey ; DMARC : un TXT _dmarc avec une politique p=none puis quarantine/reject ; veiller à l'alignement SPF/DKIM avec le domaine du From.",
  "dns-outils-diagnostic":
    "dig +norecurse @ns interroge l'autoritaire (la vérité) ; dig +trace rejoue la délégation depuis la racine ; un TTL décroissant prouve une réponse en cache.",
};

const HORS_SUJET =
  "Je préfère vous parler de la météo de la semaine, les nuages seront nombreux vendredi.";

describe("dev-web-eval — structure du harnais (≥ 30 questions, 10 production)", () => {
  it("au moins 30 questions graduées, IDs uniques, niveaux répartis", () => {
    expect(QUESTIONS_DEV_WEB.length).toBeGreaterThanOrEqual(30);
    const ids = new Set(QUESTIONS_DEV_WEB.map((q) => q.id));
    expect(ids.size).toBe(QUESTIONS_DEV_WEB.length);
    for (const q of QUESTIONS_DEV_WEB) {
      expect(q.prompt.length).toBeGreaterThan(15);
      expect(q.pointsCles.length).toBeGreaterThanOrEqual(2);
      for (const p of q.pointsCles) {
        expect(p.mots.length).toBeGreaterThanOrEqual(1);
        expect(p.poids).toBeGreaterThanOrEqual(1);
        expect(p.poids).toBeLessThanOrEqual(3);
      }
      expect(["base", "intermediaire", "avance"]).toContain(q.niveau);
    }
    const inventaire = inventaireHarnaisDevWeb();
    console.log(
      `harnais dev web : ${inventaire.total} questions (dont ${inventaire.testProduction} tests de production) — par sous-thème : ${JSON.stringify(inventaire.parSousTheme)}, par niveau : ${JSON.stringify(inventaire.parNiveau)}`,
    );
    expect(inventaire.testProduction).toBe(10);
    // les 6 sous-thèmes entraînés sont tous couverts
    expect(Object.keys(inventaire.parSousTheme).sort()).toEqual(
      ["dns", "html-css", "http-securite", "js-ts", "perf-a11y", "react-next"],
    );
  });

  it("les 10 tests de production portent EXACTEMENT les IDs demandés", () => {
    expect(QUESTIONS_TEST_PRODUCTION_DEV_WEB.map((q) => q.id)).toEqual(
      IDS_TEST_PRODUCTION_DEV_WEB,
    );
    expect(IDS_TEST_PRODUCTION_DEV_WEB).toEqual([
      "html-semantique",
      "flex-grid",
      "async-await",
      "ts-generics",
      "http-304-etag",
      "cors-preflight",
      "dns-mx-ttl",
      "dns-cname-apex",
      "dns-propagation",
      "dnssec-pourquoi",
    ]);
    for (const q of QUESTIONS_TEST_PRODUCTION_DEV_WEB) {
      expect(q.testProduction).toBe(true);
      // points clés VÉRIFIABLES : mots concrets, poids total significatif
      const poidsTotal = q.pointsCles.reduce((s, p) => s + p.poids, 0);
      expect(q.pointsCles.length).toBeGreaterThanOrEqual(4);
      expect(poidsTotal).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("dev-web-eval — scoring gradué", () => {
  it("réponse correcte > 70 → « acquis » pour les 10 tests de production", () => {
    for (const q of QUESTIONS_TEST_PRODUCTION_DEV_WEB) {
      const r = scorerReponseDevWeb(q.id, REPONSES_REFERENCE[q.id]!);
      console.log(
        `${q.id.padEnd(16)} : score ${r.score0a100} — manquants : ${r.pointsManquants.length === 0 ? "aucun" : r.pointsManquants.join(" | ")}`,
      );
      expect(r.score0a100, `question ${q.id}`).toBeGreaterThan(SEUIL_ACQUIS_DEV_WEB - 1);
      expect(r.verdict).toBe("acquis");
    }
  });

  it("réponse hors-sujet < 30 → « insuffisant » pour les 10 tests de production", () => {
    for (const q of QUESTIONS_TEST_PRODUCTION_DEV_WEB) {
      const r = scorerReponseDevWeb(q.id, HORS_SUJET);
      expect(r.score0a100, `question ${q.id}`).toBeLessThan(SEUIL_INSUFFISANT_DEV_WEB);
      expect(r.verdict).toBe("insuffisant");
      expect(r.pointsManquants.length).toBe(q.pointsCles.length);
    }
  });

  it("réponse partielle → « partiel » (entre les deux seuils)", () => {
    // couvre seulement MX (poids 3) et TTL (poids 3) sur 11 points de poids
    const r = scorerReponseDevWeb(
      "dns-mx-ttl",
      "MX désigne le serveur de courriel ; le TTL est une durée de cache en secondes.",
    );
    expect(r.verdict).toBe("partiel");
    expect(r.score0a100).toBeGreaterThanOrEqual(SEUIL_INSUFFISANT_DEV_WEB);
    expect(r.score0a100).toBeLessThan(SEUIL_ACQUIS_DEV_WEB);
    expect(r.pointsCouverts.length).toBeGreaterThan(0);
    expect(r.pointsManquants.length).toBeGreaterThan(0);
  });

  it("les 20 questions graduées passent aussi (référence acquis, hors-sujet insuffisant)", () => {
    for (const q of QUESTIONS_DEV_WEB.filter((x) => !x.testProduction)) {
      const correcte = scorerReponseDevWeb(q.id, REPONSES_REFERENCE[q.id] ?? "");
      const nulle = scorerReponseDevWeb(q.id, HORS_SUJET);
      expect(correcte.verdict, `référence ${q.id}`).toBe("acquis");
      expect(nulle.verdict, `hors-sujet ${q.id}`).toBe("insuffisant");
    }
  });

  it("déterminisme : même réponse → même score, aucune normalisation cachée", () => {
    const a = scorerReponseDevWeb("http-304-etag", REPONSES_REFERENCE["http-304-etag"]!);
    const b = scorerReponseDevWeb("http-304-etag", REPONSES_REFERENCE["http-304-etag"]!);
    expect(a).toEqual(b);
    // accents et casse neutralisés (« ETag » == « etag », « vérifié » == « verifie »)
    expect(normaliserTexteDevWeb("ETag PRIORITÉ vérifié")).toBe("etag priorite verifie");
    const sansCasse = scorerReponseDevWeb("http-304-etag", REPONSES_REFERENCE["http-304-etag"]!.toUpperCase());
    expect(sansCasse.score0a100).toBe(a.score0a100);
  });

  it("question inconnue → erreur explicite (pas de score fabriqué)", () => {
    expect(() => scorerReponseDevWeb("question-inexistante", "réponse")).toThrow(
      /inconnue/,
    );
    expect(() => scorerReponseDevWeb("", "réponse")).toThrow(/inconnue/);
  });

  it("réponse vide/absente → score 0, verdict insuffisant", () => {
    const r = scorerReponseDevWeb("dns-mx-ttl", "");
    expect(r.score0a100).toBe(0);
    expect(r.verdict).toBe("insuffisant");
  });
});
