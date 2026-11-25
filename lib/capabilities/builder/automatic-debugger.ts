/**
 * AUTOMATIC DEBUGGER (UCE-016) — diagnostic et correction BORNÉE des échecs
 * d'exécution sandbox du builder. Tropïes d'erreurs courantes identifiés
 * (dépassement de temps, OOM, appel manquant à emettre, syntaxe) avec une
 * action corrective explicite ; nombre d'essais plafonné (mission §2.E : le
 * correctif reste sous contrôle, jamais de boucle infinie).
 */

import "server-only";

export interface DiagnosticEchec {
  cause: string;
  categorie: "timeout" | "memoire" | "sortie-manquante" | "syntaxe" | "logique" | "inconnue";
  corrective?: string;
}

/** Analyse la sortie sandbox réelle et propose une correction bornée. */
export function diagnostiquerEchec(erreur: string | undefined, journaux: string[]): DiagnosticEchec {
  const tout = [erreur ?? "", ...journaux].join("\n").slice(0, 4_000);
  if (/timeout|deadline dépassée/i.test(tout)) {
    return { cause: "dépassement du temps d'exécution sandbox", categorie: "timeout", corrective: "réduire le périmètre du scénario (données plus petites) et re-tenter — max 2 essais" };
  }
  if (/heap|out of memory|allocation/i.test(tout)) {
    return { cause: "mémoire sandbox insuffisante", categorie: "memoire", corrective: "simplifier les données d'entrée (pas d'augmentation de heap : limite UCE non négociable)" };
  }
  if (/n'a rien émis|no result|balise.*résultat/i.test(tout)) {
    return { cause: "le script n'a pas appelé emettre() (aucun résultat balisé)", categorie: "sortie-manquante", corrective: "régénérer le code avec le gabarit d'archétype (emettre obligatoire sur toutes les branches)" };
  }
  if (/SyntaxError|Unexpected token|ReferenceError|TypeError/i.test(tout)) {
    return {
      cause: `erreur de syntaxe/exécution : ${(/(?:SyntaxError|Unexpected token|ReferenceError|TypeError)[^\n]*/.exec(tout) ?? ["inconnue"])[0].slice(0, 160)}`,
      categorie: "syntaxe",
      corrective: "régénérer depuis l'archétype (les corps d'archétypes sont syntaxiquement éprouvés) — jamais de patch texte ad hoc",
    };
  }
  return { cause: erreur?.slice(0, 200) ?? "échec sans message exploitable", categorie: "inconnue", corrective: undefined };
}

export interface EssaiCorrection {
  essai: number;
  diagnostic: DiagnosticEchec;
  reGenere: boolean;
  ok: boolean;
}

export interface ResultatDebug {
  succes: boolean;
  essais: EssaiCorrection[];
  causeFinale?: string;
}

/**
 * Boucle de correction BORNÉE : au plus `essaisMax` régénérations. Chaque
 * essai est journalisé — aucun essai silencieux, aucun dépassement de budget.
 */
export async function corrigerAvecBudget(
  executer: () => Promise<{ ok: boolean; erreur?: string; journaux: string[] }>,
  regenerer: (diagnostic: DiagnosticEchec) => Promise<boolean>,
  essaisMax = 2,
): Promise<ResultatDebug> {
  const essais: EssaiCorrection[] = [];
  for (let i = 0; i <= essaisMax; i++) {
    const resultat = await executer();
    if (resultat.ok) {
      essais.push({ essai: i, diagnostic: { cause: "succès", categorie: "logique" }, reGenere: i > 0, ok: true });
      return { succes: true, essais };
    }
    const diagnostic = diagnostiquerEchec(resultat.erreur, resultat.journaux);
    const dernierEssai = i === essaisMax;
    const reGenere = !dernierEssai && diagnostic.corrective !== undefined;
    if (reGenere) {
      await regenerer(diagnostic);
    }
    essais.push({ essai: i, diagnostic, reGenere, ok: false });
    if (dernierEssai) {
      return { succes: false, essais, causeFinale: `${diagnostic.categorie} : ${diagnostic.cause}${diagnostic.corrective ? ` (correction suggérée : ${diagnostic.corrective})` : ""}` };
    }
  }
  return { succes: false, essais, causeFinale: "boucle de correction terminée sans succès" };
}
