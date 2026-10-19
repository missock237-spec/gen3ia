import { describe, expect, it } from "vitest";

import {
  CoffreChiffre,
  EntrepotMemoire,
  empreinteFnv,
} from "../rag/coffre-local";
import {
  IndexSemantiqueLocal,
  decouperEnFragments,
  similariteCosinus,
  tokeniser,
  vectoriser,
} from "../rag/index-semantique";
import { OndeSemantique } from "../rag/onde-semantique";
import type { ChargeFragment, ChargeRequete, MessageAgent } from "../types";
import type { NoeudAgents } from "../noeud-agents";

/* ------------------------------- coffre --------------------------- */

describe("CoffreChiffre — RAG zéro-connaissance, volet stockage", () => {
  it("chiffre, stocke, déchiffre : aller-retour exact", async () => {
    const entrepot = new EntrepotMemoire();
    const coffre = new CoffreChiffre();
    await coffre.deverrouiller(entrepot, "phrase secrète de julio");

    const id = await coffre.ecrire(entrepot, "Le rapport confidentiel dit bonjour.", "rapport");
    const clair = await coffre.lire(entrepot, id);
    expect(clair).toBe("Le rapport confidentiel dit bonjour.");
  });

  it("le stockage est illisible sans la clé (pas de texte en clair)", async () => {
    const entrepot = new EntrepotMemoire();
    const coffre = new CoffreChiffre();
    await coffre.deverrouiller(entrepot, "mot-de-passe");
    await coffre.ecrire(entrepot, "texte ultra secret qui ne doit jamais apparaître", "doc");

    for (const cle of await entrepot.cles()) {
      const brut = (await entrepot.lire(cle)) ?? "";
      expect(brut).not.toContain("ultra secret");
    }
  });

  it("une mauvaise phrase secrète dérive une autre clé : échec propre", async () => {
    const entrepot = new EntrepotMemoire();
    const coffre = new CoffreChiffre();
    await coffre.deverrouiller(entrepot, "bonne-phrase");
    const id = await coffre.ecrire(entrepot, "contenu", "e");

    const coffre2 = new CoffreChiffre();
    await coffre2.deverrouiller(entrepot, "mauvaise-phrase");
    await expect(coffre2.lire(entrepot, id)).rejects.toThrow();
  });

  it("lister ne révèle que les métadonnées (jamais le contenu)", async () => {
    const entrepot = new EntrepotMemoire();
    const coffre = new CoffreChiffre();
    await coffre.deverrouiller(entrepot, "phrase");
    await coffre.ecrire(entrepot, "un long contenu personnel que l'on ne doit pas voir", "souvenir");

    const entrees = await coffre.lister(entrepot);
    expect(entrees).toHaveLength(1);
    expect(entrees[0].etiquette).toBe("souvenir");
    expect(entrees[0].taille).toBeGreaterThan(0);
    // Le JSON stocké ne contient jamais le texte clair.
    const brut = (await entrepot.lire(entrees[0].id)) ?? "";
    expect(brut).not.toContain("personnel");
  });

  it("refuse d'écrire sans déverrouillage préalable", async () => {
    const coffre = new CoffreChiffre();
    await expect(coffre.ecrire(new EntrepotMemoire(), "x", "e")).rejects.toThrow(/verrouillé/i);
  });
});

describe("empreinteFnv", () => {
  it("est déterministe et sensible", () => {
    expect(empreinteFnv("abc")).toBe(empreinteFnv("abc"));
    expect(empreinteFnv("abc")).not.toBe(empreinteFnv("abd"));
  });
});

/* ------------------------------- index ---------------------------- */

describe("IndexSemantiqueLocal — index sémantique local", () => {
  it("tokenise en normalisant les diacritiques et les mots vides", () => {
    const jetons = tokeniser("Le château de l'Élysée est à Paris, et la mer aussi");
    expect(jetons).toContain("chateau");
    expect(jetons).toContain("elysee");
    expect(jetons).toContain("paris");
    expect(jetons).not.toContain("le");
    expect(jetons).not.toContain("et");
  });

  it("vectorise de façon déterministe et normalisée", () => {
    const v1 = vectoriser("château palais");
    const v2 = vectoriser("Château Palais");
    expect(v1).toEqual(v2);
    const norme = Math.sqrt(Object.values(v1).reduce((a, w) => a + w * w, 0));
    expect(norme).toBeCloseTo(1, 5);
  });

  it("la similarité cosinus sépare le pertinent du non-pertinent", () => {
    const requete = vectoriser("recette de tarte aux pommes");
    const proche = vectoriser("une tarte aux pommes bien dorée");
    const loin = vectoriser("la gravité quantique à boucles");
    const sProche = similariteCosinus(requete, proche);
    const sLoin = similariteCosinus(requete, loin);
    expect(sProche).toBeGreaterThan(sLoin);
    expect(sProche).toBeGreaterThan(0.2);
  });

  it("indexe et retrouve un document", () => {
    const index = new IndexSemantiqueLocal();
    const n = index.indexer(
      "Le projet Gen3ia utilise un réseau d'oscillateurs couplés pour l'inférence. " +
        "Le champ d'ondes tourne sur le GPU de l'utilisateur via WebGPU.",
      "architecture",
    );
    expect(n).toBeGreaterThan(0);
    expect(index.taille).toBe(n);

    const reponses = index.requeter("comment fonctionne le champ d'ondes WebGPU ?", 0.05);
    expect(reponses.length).toBeGreaterThan(0);
    expect(reponses[0].fragment.texte).toContain("ondes");
  });

  it("découpe les longs textes en fragments bornés", () => {
    const long = "phrase. ".repeat(200);
    const fragments = decouperEnFragments(long);
    expect(fragments.length).toBeGreaterThan(1);
    for (const f of fragments) {
      expect(f.length).toBeLessThanOrEqual(420);
    }
  });

  it("retire un document par préfixe", () => {
    const index = new IndexSemantiqueLocal();
    index.indexer("un document", "a", "doc-a");
    index.indexer("un autre", "b", "doc-b");
    expect(index.retirer("doc-a")).toBe(1);
    expect(index.taille).toBe(1);
  });
});

/* --------------------------- onde sémantique ---------------------- */

/** Nœud P2P factice : capture les émissions, rejoue les réceptions. */
function noeudFactice(id: string): {
  noeud: NoeudAgents;
  emis: MessageAgent[];
} {
  const emis: MessageAgent[] = [];
  const noeud = {
    id,
    emettre: (message: { type: string; charge: unknown; vers?: string }) => {
      emis.push({
        v: 1,
        mid: `m-${emis.length}`,
        de: id,
        vers: message.vers,
        type: message.type as MessageAgent["type"],
        charge: message.charge,
        ttl: 2,
        ts: Date.now(),
      });
    },
    demarrer: () => undefined,
    arreter: () => undefined,
  } as unknown as NoeudAgents;
  return { noeud, emis };
}

describe("OndeSemantique — requête zéro-connaissance", () => {
  it("le pair répond avec le fragment pertinent (et seulement lui)", async () => {
    const a = noeudFactice("n-a");
    const b = noeudFactice("n-b");
    const indexA = new IndexSemantiqueLocal();
    const ondeA = new OndeSemantique({
      noeud: a.noeud,
      index: indexA,
      delaiCollecte: 120,
    });

    const indexB = new IndexSemantiqueLocal();
    indexB.indexer(
      "La clé privée du serveur de production est chiffrée dans le coffre du nœud deux.",
      "secret",
    );
    const ondeB = new OndeSemantique({ noeud: b.noeud, index: indexB, delaiCollecte: 120 });

    // A diffuse sa requête…
    const promesse = ondeA.poserQuestion("où est la clé privée du serveur ?");
    await new Promise((r) => setTimeout(r, 10));
    const requete = a.emis.find((m) => m.type === "requete")!;
    const charge = requete.charge as ChargeRequete;

    // …B la reçoit et répond depuis SON index local.
    ondeB.traiterMessage({ ...requete, de: "n-a" });
    const fragmentEmis = b.emis.find((m) => m.type === "fragment");
    expect(fragmentEmis).toBeDefined();
    expect(fragmentEmis!.vers).toBe("n-a");
    const frag = fragmentEmis!.charge as ChargeFragment;
    expect(frag.requeteId).toBe(charge.requeteId);
    expect(frag.extrait).toContain("clé privée");

    // La réponse revient à A, la promesse se résout.
    ondeA.traiterMessage({ ...fragmentEmis!, de: "n-b" });
    const resultat = await promesse;
    expect(resultat.vide).toBe(false);
    expect(resultat.fragments[0].extrait).toContain("clé privée");
    expect(resultat.respondants).toBe(1);
  });

  it("le pair se TAIT quand rien ne dépasse le seuil (zéro fuite)", async () => {
    const a = noeudFactice("n-a");
    const b = noeudFactice("n-b");
    const ondeA = new OndeSemantique({
      noeud: a.noeud,
      index: new IndexSemantiqueLocal(),
      delaiCollecte: 100,
    });
    // B possède autre chose — rien de proche de la requête.
    const indexB = new IndexSemantiqueLocal();
    indexB.indexer("recette de gâteau au chocolat noir", "cuisine");
    const ondeB = new OndeSemantique({ noeud: b.noeud, index: indexB, delaiCollecte: 100 });

    const promesse = ondeA.poserQuestion("gravité quantique à boucles");
    await new Promise((r) => setTimeout(r, 10));
    const requete = a.emis.find((m) => m.type === "requete")!;
    ondeB.traiterMessage({ ...requete, de: "n-a" });

    // B n'a émis AUCUN fragment.
    expect(b.emis.filter((m) => m.type === "fragment")).toHaveLength(0);
    const resultat = await promesse;
    expect(resultat.vide).toBe(true);
  });

  it("la signature de requête ne contient pas le texte (haché seulement)", () => {
    const index = new IndexSemantiqueLocal();
    const signature = index.signatureRequete("documents confidentiels de l'entreprise");
    expect(signature.dims.length).toBeGreaterThan(0);
    expect(signature.poids.length).toBe(signature.dims.length);
    // Aucune dimension ne transporte une sous-chaîne du texte.
    for (const d of signature.dims) {
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeLessThan(256);
    }
  });
});
