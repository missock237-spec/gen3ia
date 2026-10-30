import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PANNEAU SECRETS D'EXTENSION (it.43) — conventions du dépôt : vitest
 * tourne en Node SANS jsdom ni @testing-library/react (cf.
 * components/billing/chariow-widget.test.tsx). Le câblage du panneau à
 * l'API /api/developer/secrets est verrouillé structurellement sur les
 * sources :
 *
 *  1. LES 3 VERBES SONT APPELÉS : GET (?extensionId=) pour les refs
 *     déclarées, PUT pour définir une valeur, DELETE pour retirer —
 *     l'onglet Extensions intègre le panneau (bouton « Secrets… »).
 *  2. AUCUNE VALEUR AFFICHÉE : l'API ne retourne jamais les secrets
 *     (stockage serveur uniquement) — le champ de saisie est
 *     type="password" avec autoComplete="off" et jamais de rendu de
 *     valeur existante : l'UI n'affiche que l'état configuré/à définir.
 *  3. AUTH PAR SESSION DÉVELOPPEUR : les appels passent par l'api() du
 *     DeveloperContext (authFetch Firebase) — pas de fetch brut.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PANNEAU = "components/developer/tabs/secrets-panel.tsx";
const ONGLET = "components/developer/tabs/extensions-panel.tsx";

describe("panneau Secrets d'extension (câblage /api/developer/secrets, it.43)", () => {
  const panneau = read(PANNEAU);
  const onglet = read(ONGLET);

  it("les 3 verbes de l'API sont appelés depuis le panneau", () => {
    expect(panneau).toContain("/api/developer/secrets?extensionId=");
    expect(panneau).toContain('"/api/developer/secrets"');
    expect(panneau).toContain('method: "PUT"');
    expect(panneau).toContain('method: "DELETE"');
    // L'onglet Extensions intègre bien le panneau (câblage complet).
    expect(onglet).toContain("secrets-panel");
    expect(onglet).toContain("ExtensionSecrets");
  });

  it("aucune valeur de secret n'est jamais affichée (stockage serveur uniquement)", () => {
    // Champ de saisie masqué + pas d'autoremplissage navigateur.
    expect(panneau).toContain('type="password"');
    expect(panneau).toContain('autoComplete="off"');
    // Le panneau n'affiche que l'état, jamais une valeur retournée :
    // le type local ne porte aucune donnée de valeur côté lecture.
    expect(panneau).toContain("type SecretRef = { ref: string; description?: string; configured: boolean }");
    // La valeur saisie est vidée après enregistrement (pas de réaffichage).
    expect(panneau).toContain("[ref]: \"\"");
  });

  it("les appels passent par la session développeur (authFetch du contexte)", () => {
    expect(panneau).toContain("useDeveloper()");
    // Toutes les requêtes passent par api( — aucun fetch global brut.
    expect(panneau).not.toMatch(/(?<!\.)\bfetch\(/);
    expect(panneau).toContain("await api(");
  });
});
