import * as jsYaml from "js-yaml";

import type { ErreurSyntaxe, ResultatValidation } from "./contrat";

/**
 * VALIDATEUR YAML NATIF (Module 3 : drop-and-fix) — js-yaml (schema par
 * défaut : JSON-compatible, le plus strict et le plus utile aux configs).
 * La YAMLException de js-yaml porte marque/position → ligne/colonne exactes.
 *
 * docker-compose passe par ce même validateur (c'est du YAML) + une passe
 * sémantique dédiée (services top-level, image obligatoire).
 */
export function validerYaml(contenu: string): ResultatValidation {
  try {
    jsYaml.load(contenu, { schema: jsYaml.JSON_SCHEMA });
    return { valide: true, erreurs: [] };
  } catch (erreur) {
    return { valide: false, erreurs: [localiser(erreur)] };
  }
}

/** docker-compose : YAML d'abord, sémantique compose ensuite. */
export function validerDockerCompose(contenu: string): ResultatValidation {
  const yaml = validerYaml(contenu);
  if (!yaml.valide) return yaml;
  const erreurs: ErreurSyntaxe[] = [...yaml.erreurs];

  let document: unknown;
  try {
    document = jsYaml.load(contenu, { schema: jsYaml.JSON_SCHEMA });
  } catch {
    return yaml; // course improbable (contenu muté) : retour YAML
  }

  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { valide: false, erreurs: [{ ligne: 1, colonne: 1, message: "docker-compose : le document racine doit être une table (services, volumes, networks…)" }] };
  }
  const racine = document as Record<string, unknown>;
  if (!("services" in racine) || racine.services === null || typeof racine.services !== "object" || Array.isArray(racine.services)) {
    erreurs.push({ ligne: 1, colonne: 1, message: "docker-compose : section top-level « services: » absente ou vide" });
  } else {
    const services = racine.services as Record<string, unknown>;
    for (const [nom, valeur] of Object.entries(services).slice(0, 100)) {
      if (valeur === null || typeof valeur !== "object" || Array.isArray(valeur)) {
        erreurs.push({ ligne: ligneDe(contenu, nom), colonne: 3, message: `service « ${nom} » : doit être une table (build/image, ports…)` });
        continue;
      }
      const config = valeur as Record<string, unknown>;
      if (!("image" in config) && !("build" in config)) {
        erreurs.push({ ligne: ligneDe(contenu, nom), colonne: 3, message: `service « ${nom} » : ni image: ni build: déclaré` });
      }
    }
  }
  return { valide: erreurs.length === 0, erreurs };
}

/** Ligne approximative de la clé `nom` (cherchée en marge faible). */
function ligneDe(contenu: string, nom: string): number {
  const re = new RegExp(`^\\s{2,4}${nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m");
  const match = re.exec(contenu);
  return match ? contenu.slice(0, match.index).split("\n").length : 1;
}

function localiser(erreur: unknown): ErreurSyntaxe {
  const anyErreur = erreur as { message?: string; mark?: { line?: number; column?: number } };
  if (anyErreur?.mark && typeof anyErreur.mark.line === "number") {
    return {
      ligne: anyErreur.mark.line + 1, // js-yaml est 0-indexé
      colonne: (anyErreur.mark.column ?? 0) + 1,
      message: (anyErreur.message ?? "erreur YAML").split("\n")[0].slice(0, 300),
    };
  }
  return { ligne: 0, colonne: 0, message: (anyErreur?.message ?? "erreur YAML").split("\n")[0].slice(0, 300) };
}
