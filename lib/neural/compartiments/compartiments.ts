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
 *
 * it.150 — DOMAINE « DÉVELOPPEMENT WEB » : la mémoire de domaines est
 * alimentée AU DÉMARRAGE par le corpus commis dev web + DNS (2441 unités
 * réelles, sous-thèmes html-css/js-ts/react-next/http-securite/perf-a11y/
 * dns) via ingereDevWebCorpus — le domaine devient consultable par la
 * mémoire (annexe + voie « mémorisée ») et visible dans la comptabilité
 * du compartiment developpement-web|texte.
 */

import { CORPUS_DEV_WEB_DNS } from "../generation/corpus-dev-web-dns";
import { CORPUS_DEV_WEB_HTML_CSS } from "../generation/corpus-dev-web-html-css";
import { CORPUS_DEV_WEB_HTTP_SECURITE } from "../generation/corpus-dev-web-http-securite";
import { CORPUS_DEV_WEB_JS_TS } from "../generation/corpus-dev-web-js-ts";
import { CORPUS_DEV_WEB_PERF_A11Y } from "../generation/corpus-dev-web-perf-a11y";
import { CORPUS_DEV_WEB_REACT_NEXT } from "../generation/corpus-dev-web-react-next";
import { MemoireDomainesGen3, unitesDevWebDepuisPaires } from "../generation/memoire-domaines";
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

/** Corpus commis du domaine « developpement-web » (6 sous-thèmes it.150),
 * converti en unités mémoire une seule fois par process. */
function corpusDevWebCommis() {
  return unitesDevWebDepuisPaires([
    ...CORPUS_DEV_WEB_DNS,
    ...CORPUS_DEV_WEB_HTML_CSS,
    ...CORPUS_DEV_WEB_HTTP_SECURITE,
    ...CORPUS_DEV_WEB_JS_TS,
    ...CORPUS_DEV_WEB_PERF_A11Y,
    ...CORPUS_DEV_WEB_REACT_NEXT,
  ]);
}

export function creerCompartimentsGen3(): CompartimentsGen3 {
  const memoireDomaines = new MemoireDomainesGen3();
  // it.150 — ingestion du corpus commis dev web + DNS (idempotent, honnête)
  memoireDomaines.ingereDevWebCorpus(corpusDevWebCommis());
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
