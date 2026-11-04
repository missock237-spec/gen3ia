import * as vm from "node:vm";
import type * as tsTypes from "typescript";

import type { ResultatValidation } from "./contrat";

/**
 * VALIDATEUR JAVASCRIPT / TYPESCRIPT NATIF (Module 3 : drop-and-fix).
 *
 * SÛRETÉ : le contenu n'est JAMAIS exécuté —
 *   · JS : vm.Script compile la syntaxe (V8) sans `.run()` — SyntaxError
 *     localisée (lineNumber de la pile) ;
 *   · TS : le compilateur TypeScript analyse en mémoire
 *     (ts.createSourceFile + parseDiagnostics), sans émission de code —
 *     chargé en IMPORT DYNAMIQUE paresseux (serverExternalPackages :
 *     jamais bundlé, requis depuis node_modules au runtime) ; si absent du
 *     déploiement, échec HONNÊTE explicite (pas de validation simulée).
 */
export function validerJavascript(contenu: string): ResultatValidation {
  try {
    new vm.Script(contenu, { filename: "artefact.js" });
    return { valide: true, erreurs: [] };
  } catch (erreur) {
    const message = erreur instanceof Error ? erreur.message : String(erreur);
    return { valide: false, erreurs: [{ ligne: ligneDepuisPile(erreur), colonne: 0, message: message.split("\n")[0].slice(0, 300) }] };
  }
}

/** Charge le compilateur TS paresseusement (retour null = absent). */
async function chargerCompilateurTs(): Promise<typeof import("typescript") | null> {
  try {
    return (await import("typescript")) as typeof import("typescript");
  } catch {
    return null;
  }
}

export async function validerTypescript(contenu: string): Promise<ResultatValidation> {
  const ts = await chargerCompilateurTs();
  if (!ts) {
    return {
      valide: false,
      erreurs: [{ ligne: 0, colonne: 0, message: "compilateur TypeScript indisponible sur ce déploiement — validation .ts non réalisable (échec honnête, aucune simulation)" }],
    };
  }

  // API publique stable : transpileModule avec reportDiagnostics → diagnostics
  // de PARSE (le contenu n'est ni émis ni exécuté — on ignore la sortie).
  const { diagnostics } = ts.transpileModule(contenu, {
    fileName: "artefact.ts",
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const pertinentes = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).slice(0, 20);
  if (pertinentes.length === 0) return { valide: true, erreurs: [] };

  return {
    valide: false,
    erreurs: pertinentes.map((d: tsTypes.Diagnostic) => {
      // Diagnostic de transpile : file == artefact.ts → start est un offset
      // dans le contenu ; getLineAndCharacterOfPosition exige un SourceFile
      // → localisation directe depuis l'offset (ligne/colonne calculées).
      if (d.file && typeof d.start === "number") {
        const debut = d.file.getLineAndCharacterOfPosition(d.start);
        return {
          ligne: debut.line + 1,
          colonne: debut.character + 1,
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 300),
        };
      }
      return {
        ligne: 0,
        colonne: 0,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 300),
      };
    }),
  };
}

/** Extrait la ligne depuis la pile V8 (« artefact.js:3:14 »). */
function ligneDepuisPile(erreur: unknown): number {
  const pile = erreur instanceof Error ? erreur.stack ?? "" : "";
  const match = /artefact\.js:(\d+)/.exec(pile);
  return match ? Number(match[1]) : 0;
}
