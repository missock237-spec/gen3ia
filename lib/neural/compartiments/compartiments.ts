/**
 * ASSEMBLAGE DES COMPARTIMENTS CALCULABLES GEN3 (demande propriétaire :
 * quatre organes branchés au cerveau — math, sciences/monde virtuel,
 * code/terminal, raisonnement — plus la passerelle à IA utilisatrices).
 *
 * La fabrique crée des instances FRAÎCHES (le runtime du cerveau en crée
 * une par process ; les tests créent les leurs) et câble les dépendances
 * entre compartiments :
 *   - le terminal virtuel consulte le compartiment math, le monde et la
 *     mémoire de domaines (commandes calc/monde/memoire/sources) ;
 *   - l'orchestrateur de raisonnement sollicite les trois compartiments
 *     ET la mémoire de domaines (rappel + classification) ;
 *   - la passerelle s'appuie sur le monde virtuel (observations réelles).
 */

import { MemoireDomainesGen3 } from "../generation/memoire-domaines";
import { evaluerExpression, resoudreProbleme } from "./moteur-math";
import { CompartimentMondeGen3, PasserelleIaUtilisateurs } from "./monde-virtuel";
import { OrchestrateurRaisonnementGen3 } from "./orchestrateur-raisonnement";
import { TerminalVirtuelGen3 } from "./terminal-virtuel";

export interface CompartimentsGen3 {
  readonly math: {
    readonly resoudreProbleme: typeof resoudreProbleme;
    readonly evaluerExpression: typeof evaluerExpression;
  };
  readonly monde: CompartimentMondeGen3;
  readonly terminal: TerminalVirtuelGen3;
  readonly orchestrateur: OrchestrateurRaisonnementGen3;
  readonly passerelle: PasserelleIaUtilisateurs;
  readonly memoireDomaines: MemoireDomainesGen3;
}

export function creerCompartimentsGen3(): CompartimentsGen3 {
  const memoireDomaines = new MemoireDomainesGen3();
  const monde = new CompartimentMondeGen3();
  const math = { resoudreProbleme, evaluerExpression };
  const terminal = new TerminalVirtuelGen3({ math, monde, memoireDomaines });
  const orchestrateur = new OrchestrateurRaisonnementGen3({
    math,
    monde,
    terminal,
    memoireDomaines,
  });
  const passerelle = new PasserelleIaUtilisateurs();
  return { math, monde, terminal, orchestrateur, passerelle, memoireDomaines };
}
