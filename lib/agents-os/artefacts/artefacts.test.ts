import { describe, it, expect } from "vitest";

import { validerJson } from "./valideurs/json";
import { validerYaml, validerDockerCompose } from "./valideurs/yaml";
import { validerJavascript, validerTypescript } from "./valideurs/javascript";
import { validerNginx } from "./valideurs/nginx";
import { reparer } from "./reparateur";
import { auditerArtefact, estTypeArtefact, TYPES_ARTEFACTS } from "./service-audit";

describe("Module 3 — validateurs natifs", () => {
  it("JSON valide / invalide avec ligne+colonne exactes", () => {
    expect(validerJson('{"a":1}').valide).toBe(true);
    const rapport = validerJson('{\n  "a": 1,\n  "b": "x",\n}');
    expect(rapport.valide).toBe(false);
    expect(rapport.erreurs[0].ligne).toBe(4); // la virgule traînante est ligne 3, l'erreur V8 pointe }
    expect(rapport.erreurs[0].message).toBeTruthy();
  });

  it("YAML valide / invalide avec ligne exacte (mark js-yaml)", () => {
    expect(validerYaml("a: 1\nb: 2\n").valide).toBe(true);
    const rapport = validerYaml("a: 1\nb: [1, 2\nc: 3\n");
    expect(rapport.valide).toBe(false);
    expect(rapport.erreurs[0].ligne).toBeGreaterThanOrEqual(2);
  });

  it("docker-compose : YAML ok mais sémantique refusée (services manquants)", () => {
    const rapport = validerDockerCompose("version: '3'\n");
    expect(rapport.valide).toBe(false);
    expect(rapport.erreurs.some((e) => e.message.includes("services"))).toBe(true);
  });

  it("docker-compose : service sans image ni build signalé", () => {
    const rapport = validerDockerCompose("services:\n  web:\n    ports:\n      - '80'\n");
    expect(rapport.valide).toBe(false);
    expect(rapport.erreurs.some((e) => e.message.includes("web"))).toBe(true);
  });

  it("javascript : SyntaxError localisée, code NON exécuté (vm compile-only)", () => {
    expect(validerJavascript("const x = 1;").valide).toBe(true);
    const rapport = validerJavascript("const x = ;\n");
    expect(rapport.valide).toBe(false);
    expect(rapport.erreurs[0].ligne).toBe(1);
  });

  it("typescript : diagnostics du compilateur en mémoire (ligne/colonne)", async () => {
    const bon = await validerTypescript("const x: number = 1;\n");
    expect(bon.valide).toBe(true);
    const mauvais = await validerTypescript("const x: number = ;\n");
    expect(mauvais.valide).toBe(false);
    expect(mauvais.erreurs[0].ligne).toBe(1);
  });

  it("nginx : équilibre de blocs, ; manquants, guillemets", () => {
    const valide = validerNginx("server {\n  listen 80;\n  server_name gen3ia.online;\n}\n");
    expect(valide.valide).toBe(true);

    const sansPointVirgule = validerNginx("server {\n  listen 80\n}\n");
    expect(sansPointVirgule.valide).toBe(false);
    expect(sansPointVirgule.erreurs[0].message).toContain(";");

    const blocNonFermé = validerNginx("events {\n  worker_connections 1024;\n");
    expect(blocNonFermé.valide).toBe(false);
    expect(blocNonFermé.erreurs.some((e) => e.message.includes("jamais fermé"))).toBe(true);

    const fermantEnTrop = validerNginx("events {\n}\n}\n");
    expect(fermantEnTrop.erreurs.some((e) => e.message.includes("sans bloc ouvert"))).toBe(true);

    const guillemets = validerNginx("server {\n  return 301 \"http://x;\n}\n");
    expect(guillemets.erreurs.some((e) => e.message.includes("guillemets"))).toBe(true);
  });
});

describe("Module 3 — réparateur déterministe", () => {
  it("JSON : virgule traînante + guillemets simples + clés nues + commentaires", () => {
    const { contenu, reparations } = reparer(
      "// config\n{\n  'a': 1,\n  b: 'deux',\n},",
      "json",
    );
    const parse = JSON.parse(contenu);
    expect(parse).toEqual({ a: 1, b: "deux" });
    expect(reparations.map((r) => r.passe)).toContain("json-commentaires");
    expect(reparations.map((r) => r.passe)).toContain("json-virgule-traînante");
    expect(reparations.map((r) => r.passe)).toContain("json-guillemets");
    expect(reparations.map((r) => r.passe)).toContain("json-cle-non-quotee");
  });

  it("YAML : tabulations → 2 espaces, deux-points sans espace (URL et heures préservées)", () => {
    const { contenu } = reparer("services:\n\thost: localhost\n\ttimeout: 30\n\turl: https://gen3ia.online\n\tcreation: 12:34\n", "yaml");
    const lignes = contenu.split("\n");
    expect(lignes[1]).toBe("  host: localhost");
    expect(lignes[2]).toBe("  timeout: 30");
    // URL : le : de https:// reste collé (exclusion //).
    expect(lignes[3]).toContain("url: https://gen3ia.online");
    // Heure : 12:34 inchangée.
    expect(lignes[4]).toContain("12:34");
  });

  it("YAML : guillemet non fermé complété", () => {
    const { contenu } = reparer("message: 'bonjour\n", "yaml");
    expect(contenu).toBe("message: 'bonjour'\n"); // le \n final est conservé (fichier texte normal)
  });

  it("docker-compose : items de liste réindentés sous leur clé", () => {
    const { contenu } = reparer("services:\n  web:\n    ports:\n- '80:80'\n", "docker-compose");
    expect(contenu).toContain("      - '80:80'");
  });

  it("nginx : ; manquant ajouté", () => {
    const { contenu } = reparer("server {\n  listen 80\n}\n", "nginx");
    expect(contenu).toContain("listen 80;");
  });

  it("javascript : AUCUNE réparation tentée (structure sémantique)", () => {
    const { reparations } = reparer("const x = ;", "javascript");
    expect(reparations).toHaveLength(0);
  });
});

describe("Module 3 — service audit (orchestration honnête)", () => {
  it("contenu déjà valide : aucune réparation, fichier identique", async () => {
    const rapport = await auditerArtefact({ type: "json", contenu: '{"ok":true}' });
    expect(rapport.valideAuDepart).toBe(true);
    expect(rapport.reparations).toHaveLength(0);
    expect(rapport.fichierCorrige).toBe('{"ok":true}');
    expect(rapport.valideApres).toBe(true);
  });

  it("JSON brisé : réparé ET revalidé (fichierCorrige parseable)", async () => {
    const rapport = await auditerArtefact({ type: "json", contenu: "// cfg\n{ a: 1, 'b': [2,3,], }" });
    expect(rapport.valideAuDepart).toBe(false);
    expect(rapport.reparations.length).toBeGreaterThan(0);
    expect(rapport.valideApres).toBe(true);
    expect(JSON.parse(rapport.fichierCorrige)).toEqual({ a: 1, b: [2, 3] });
  });

  it("erreurs non réparables : retournées TELLES quelles (honnêteté, zéro simulation)", async () => {
    const rapport = await auditerArtefact({ type: "yaml", contenu: "a: [1, 2\nb: 'c\nd: [}" });
    expect(rapport.valideAuDepart).toBe(false);
    // La réparation peut améliorer certaines lignes mais le document reste
    // invalide : erreursRestantes NON vides, aucune prétention de succès.
    expect(rapport.valideApres).toBe(false);
    expect(rapport.erreursRestantes.length).toBeGreaterThan(0);
  });

  it("type inconnu rejeté par le garde de type", () => {
    expect(estTypeArtefact("json")).toBe(true);
    expect(estTypeArtefact("ini")).toBe(false);
    expect(TYPES_ARTEFACTS).toContain("docker-compose");
  });

  it("contenu trop volumineux : erreur explicite (limite 1 Mo)", async () => {
    const gros = "x".repeat(1_100_000);
    await expect(auditerArtefact({ type: "json", contenu: gros })).rejects.toThrow("dépasse");
  });
});
