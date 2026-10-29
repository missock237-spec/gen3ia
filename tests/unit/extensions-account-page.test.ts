import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrous structurels — PAGE « MES EXTENSIONS » (itération 31, Job 478451).
 *
 * Constat d'audit (garde anti-code-mort it.29) : quatre endpoints du lot
 * marketplace (/api/extensions/{installed,purchases,licenses,usage})
 * étaient livrés, testés, déployés — sans AUCUNE surface utilisateur.
 * L'utilisateur ne pouvait ni voir ses installations, ni ses achats,
 * ni ses licences, ni l'usage réel de ses extensions.
 *
 * Le présent lot câble la page /extensions (entrée « Mes extensions »
 * dans le groupe Ressources de la navigation). Convention du dépôt :
 * ces verrous lisent les sources pour empêcher toute régression
 * (cf. settings-consents.test.ts, account-export.test.ts).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const vue = read("components/extensions/account-view.tsx");
const page = read("app/extensions/page.tsx");
const registre = read("components/shells/nav-registry.ts");
const navItems = read("components/nav/nav-items.ts");

describe("it.31 — la page /extensions existe et monte la vue compte", () => {
  it("app/extensions/page.tsx importe et rend ExtensionsAccount", () => {
    expect(page).toContain('import { ExtensionsAccount } from "@/components/extensions/account-view"');
    expect(page).toContain("<ExtensionsAccount />");
    // Métadonnées propres (SEO) comme les autres pages ressources.
    expect(page).toContain('title: "Mes extensions"');
    // Palette page : tokens g3-* uniquement.
    expect(page).toContain('bg-[var(--g3-bg)]');
    expect(page).toContain('text-[var(--g3-text)]');
  });

  it("la navigation déclare la route /extensions (registre unique + groupe Ressources)", () => {
    expect(registre).toContain('id: "extensions"');
    expect(registre).toContain('href: "/extensions"');
    expect(registre).toContain('label: "Mes extensions"');
    // La route est une route workspace secondaire (cohérente avec
    // /integrations et /billing) — visible dans la palette de commandes
    // et le fil d'Ariane qui dérivent du même registre.
    const entree = registre.indexOf('id: "extensions"');
    const contexte = registre.indexOf('contexts: ["workspace"]', entree);
    expect(contexte).toBeGreaterThan(entree);
    expect(contexte).toBeLessThan(entree + 400);
    // Le groupe Ressources de la nav principale inclut la nouvelle entrée.
    expect(navItems).toContain('groupByIds(["integrations", "extensions", "storage"])');
  });
});

describe("it.31 — les 4 endpoints orphelins sont appelés avec le bon contrat", () => {
  it("lecture initiale parallèle : installed + purchases + licenses", () => {
    expect(vue).toContain('"/api/extensions/installed"');
    expect(vue).toContain('"/api/extensions/purchases"');
    expect(vue).toContain('"/api/extensions/licenses"');
    // Les trois lectures partent en Promise.all (une seule attente) —
    // on isole le BLOC Promise.all pour éviter les mentions du JSDoc.
    const debut = vue.indexOf("Promise.all([");
    expect(debut).toBeGreaterThan(-1);
    const fin = vue.indexOf("])", debut);
    const bloc = vue.slice(debut, fin);
    expect(bloc).toContain("/api/extensions/installed");
    expect(bloc).toContain("/api/extensions/purchases");
    expect(bloc).toContain("/api/extensions/licenses");
  });

  it("usage : GET /api/extensions/usage?extensionId=… avec paramètre encodé", () => {
    expect(vue).toContain("/api/extensions/usage?extensionId=");
    // Le paramètre est encodé (jamais interpolé brut).
    expect(vue).toContain("encodeURIComponent(extensionId)");
    // Retour serveur = source de vérité (executions ?? []).
    expect(vue).toContain("corps.executions ?? []");
  });

  it("le contrat honnête du serveur est restitué : 403 usage non installé et erreur affichée telle quelle", () => {
    // Le serveur répond 403 « Extension non installée. » — l'UI ne
    // fabrique PAS un état optimiste : elle affiche le message serveur.
    expect(vue).toContain("if (!reponse.ok) throw new Error(corps.error ||");
    expect(vue).toContain('texte: cause instanceof Error ? cause.message :');
  });
});

describe("it.31 — honnêteté du canal de paiement et des statuts", () => {
  it("les achats affichent le canal réel (Portefeuille ou Chariow) et le statut brut", () => {
    // Chariow est l'unique canal de paiement externe de la plateforme —
    // l'UI affiche les DEUX canaux possibles sans les fondre.
    expect(vue).toContain('wallet: "Portefeuille"');
    expect(vue).toContain('chariow: "Chariow"');
    // Les 4 statuts serveur sont libellés (pending | paid | failed | refunded).
    expect(vue).toContain('pending: "En attente"');
    expect(vue).toContain('paid: "Payée"');
    expect(vue).toContain('failed: "Échouée"');
    expect(vue).toContain('refunded: "Remboursée"');
    // Montant : minor units → décimales explicites (pas de division flottante masquée).
    expect(vue).toContain("amountMinor / 100");
  });

  it("la page constate, elle ne vend pas (aucun appel d'achat ni d'installation)", () => {
    // Aucune mutation : la vue ne POST/PUT/PATCH/DELETE rien.
    expect(vue).not.toContain('method: "POST"');
    expect(vue).not.toContain('method: "PUT"');
    expect(vue).not.toContain('method: "PATCH"');
    expect(vue).not.toContain('method: "DELETE"');
    // Le renvoi vers les surfaces d'achat est explicite.
    expect(vue).toContain("Facturation");
  });
});

describe("it.31 — accessibilité et palette", () => {
  it("a11y : bouton usage avec aria-expanded, zone role=status, états disabled", () => {
    expect(vue).toContain('role="status"');
    expect(vue).toContain('aria-live="polite"');
    expect(vue).toContain("aria-expanded={usageOuvert === installation.extensionId}");
    expect(vue).toContain("disabled={usageEnCours !== null}");
    expect(vue).toContain('aria-labelledby="extensions-installations-titre"');
  });

  it("palette : tokens g3-* uniquement (convention du dépôt, cf. it.30)", () => {
    // Aucune couleur brute : les valeurs arbitraires Tailwind ne peuvent
    // référencer que des tokens var(--g3-*). (Les tokens typographiques
    // comme var(--font-display) ne sont pas des couleurs.)
    const couleursBrutes = vue.match(/(bg|text|border)-\[(?!var\(--g3-)/g) ?? [];
    expect(couleursBrutes).toEqual([]);
  });
});
