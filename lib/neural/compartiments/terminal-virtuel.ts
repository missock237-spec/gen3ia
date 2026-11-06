/**
 * COMPARTIMENT CODE GEN3 — LE TERMINAL VIRTUEL (demande propriétaire :
 * « pour le code, il doit y avoir un terminal virtuel intégré à gen3 qui
 * lui permettra d'exécuter du code et des commandes »).
 *
 * PRINCIPE (honnête, borné, sûr) :
 *   - Gen3 dispose de SON propre terminal : des commandes simples (aide,
 *     calc, memoire, sources, monde, etat, historique) et une exécution
 *     JavaScript SANDBOXÉE (node:vm — contexte neuf, globaux gelés, PAS de
 *     require/process/import, codeGeneration désactivée, timeout 1 s,
 *     sortie bornée) ;
 *   - le terminal est un ORGANE DU CERVEAU : l'orchestrateur de raisonnement
 *     le sollicite quand une requête demande une exécution, et l'API
 *     /api/compartiments l'expose aux applications ;
 *   - tout est tracé dans un anneau borné (256 entrées) — gen3 relit
 *     l'historique de ses propres exécutions.
 *
 * SÉCURITÉ (défense en profondeur) : le sandbox n'a aucun accès au disque,
 * au réseau, aux variables d'environnement ; une boucle infinie est tuée
 * par le timeout du vm ; la sortie est tronquée ; les commandes sont
 * plafonnées en taille.
 */

import { createContext, runInContext } from "node:vm";

import {
  evaluerExpression,
  formaterNombre,
  formuleReponse,
  resoudreProbleme,
  type ResultatCalcul,
} from "./moteur-math";
import type { CompartimentMondeGen3 } from "./monde-virtuel";

/** Contrat structural (typage en canard) — satisfait par MemoireDomainesGen3
 * sans dépendance d'import (évite tout cycle de modules). */
export interface SourceMemoireTerminal {
  etatCompartiment(
    domaine: string,
    capacite: string,
  ): {
    cle: string;
    quotaOctets: number;
    octetsPhysiques: number;
    octetsReels: number;
    octetsGraine: number;
    octetsInges: number;
    expansionDeterministe: boolean;
    unitesAdressables: number;
    tauxCouverturePhysique: number;
    ecartRestantOctets: number;
  };
  sourcesDomaine(domaine: string): readonly { nom: string; plateforme: string; reference: string; statut: string; emplacement: string }[];
  statistiques(): { compartiments: number; octetsReels: number; octetsInges: number; enseignements: number };
}

export interface ResultatTerminal {
  /** Sortie texte (tronquée à LIMITE_SORTIE caractères). */
  readonly sortie: string;
  /** 0 = succès ; 1 = erreur d'exécution ; 127 = commande inconnue. */
  readonly exitCode: number;
  /** La commande interprétée (premier token). */
  readonly commande: string;
  readonly dureeMs: number;
}

export const LIMITE_SORTIE = 2000;
export const TIMEOUT_VM_MS = 1000;
export const CAPACITE_HISTORIQUE_TERMINAL = 256;
export const LIMITE_COMMANDE = 20_000;

function tronquer(texte: string): string {
  return texte.length > LIMITE_SORTIE
    ? `${texte.slice(0, LIMITE_SORTIE)}… [sortie tronquée à ${LIMITE_SORTIE} caractères]`
    : texte;
}

/** Sérialise une valeur du sandbox sans jamais lever (cycles, fonctions,
 * proxys vm) — la sortie du terminal reste toujours impréable. */
function serialiserValeur(valeur: unknown): string {
  if (valeur === undefined) return "undefined";
  if (typeof valeur === "string") return valeur;
  try {
    return JSON.stringify(valeur) ?? String(valeur);
  } catch {
    try {
      return String(valeur);
    } catch {
      return "(valeur non sérialisable)";
    }
  }
}

export interface EnvironnementTerminal {
  math?: {
    resoudreProbleme(q: string): ResultatCalcul;
  };
  monde?: Pick<CompartimentMondeGen3, "repondre" | "capacites">;
  memoireDomaines?: SourceMemoireTerminal | null;
}

interface EntreeHistorique {
  readonly commande: string;
  readonly exitCode: number;
  readonly dureeMs: number;
  readonly horodatage: number;
}

/**
 * LE TERMINAL VIRTUEL DE GEN3 — organe d'exécution du cerveau.
 * Instanciable tel quel (tests, API) ; câblé au compartiment monde et à la
 * mémoire de domaines pour les commandes de consultation.
 */
export class TerminalVirtuelGen3 {
  private readonly historique: EntreeHistorique[] = [];
  private readonly compteurParCommande = new Map<string, number>();

  constructor(private readonly env: EnvironnementTerminal = {}) {}

  /**
   * Exécute une commande du terminal virtuel. JAMAIS d'effet destructeur :
   * le sandbox n'a accès à rien d'autre que ses globaux gelés.
   */
  executerCommande(entree: string): ResultatTerminal {
    const debut = Date.now();
    const entreePropre = entree.trim().slice(0, LIMITE_COMMANDE);
    const espace = entreePropre.indexOf(" ");
    const nom = (espace === -1 ? entreePropre : entreePropre.slice(0, espace)).toLowerCase();
    const reste = espace === -1 ? "" : entreePropre.slice(espace + 1).trim();

    let resultat: ResultatTerminal;
    switch (nom) {
      case "aide":
        resultat = this.cmdAide();
        break;
      case "calc":
        resultat = this.cmdCalc(reste);
        break;
      case "js":
        resultat = this.cmdJs(reste);
        break;
      case "monde":
        resultat = this.cmdMonde(reste);
        break;
      case "memoire":
        resultat = this.cmdMemoire(reste);
        break;
      case "sources":
        resultat = this.cmdSources(reste);
        break;
      case "etat":
        resultat = this.cmdEtat();
        break;
      case "historique":
        resultat = this.cmdHistorique();
        break;
      case "historique-vider":
        this.historique.length = 0;
        resultat = { sortie: "Historique du terminal vidé.", exitCode: 0, commande: nom, dureeMs: Date.now() - debut };
        break;
      case "":
        resultat = { sortie: "Terminal virtuel Gen3 — tapez « aide » pour la liste des commandes.", exitCode: 0, commande: "", dureeMs: Date.now() - debut };
        break;
      default:
        resultat = {
          sortie: `Commande inconnue : « ${nom} ». Commandes : aide, calc, js, monde, memoire, sources, etat, historique, historique-vider.`,
          exitCode: 127,
          commande: nom,
          dureeMs: Date.now() - debut,
        };
    }

    const entreeHistorique: EntreeHistorique = {
      commande: entreePropre.slice(0, 200),
      exitCode: resultat.exitCode,
      dureeMs: resultat.dureeMs,
      horodatage: debut,
    };
    this.historique.push(entreeHistorique);
    if (this.historique.length > CAPACITE_HISTORIQUE_TERMINAL) {
      this.historique.splice(0, this.historique.length - CAPACITE_HISTORIQUE_TERMINAL);
    }
    this.compteurParCommande.set(nom, (this.compteurParCommande.get(nom) ?? 0) + 1);
    return resultat;
  }

  // ─── Commandes ─────────────────────────────────────────────────────────────

  private cmdAide(): ResultatTerminal {
    const debut = Date.now();
    const lignes = [
      "Terminal virtuel Gen3 (compartiment code) — commandes :",
      "  aide                — cette liste",
      "  calc <expression>   — calcul exact via le compartiment math (ex : calc (3+4)*2)",
      "  js <code>           — exécution JavaScript sandboxée (ex : js Math.sqrt(144))",
      "  monde <question>    — simulation du monde virtuel (ex : monde projectile 20 m/s 45 degres)",
      "  memoire <domaine> [capacite] — comptabilité 1 Go d'un compartiment (ex : memoire math texte)",
      "  sources <domaine>   — registre des datasets HF/Kaggle d'un domaine",
      "  etat                — état global de la mémoire de domaines",
      "  historique          — dernières commandes exécutées",
      "  historique-vider    — vide l'historique",
      "Sandbox js : contexte neuf (intrinsics propres, Math/JSON…), pas de require/process/import, codeGeneration désactivée, timeout 1 s, sortie bornée.",
    ];
    return { sortie: lignes.join("\n"), exitCode: 0, commande: "aide", dureeMs: Date.now() - debut };
  }

  private cmdCalc(reste: string): ResultatTerminal {
    const debut = Date.now();
    if (reste.length === 0) {
      return { sortie: "Usage : calc <expression> (ex : calc 17*23)", exitCode: 1, commande: "calc", dureeMs: Date.now() - debut };
    }
    // D'abord le problème complet (familles : pourcentage, conversion…)…
    const probleme = this.env.math?.resoudreProbleme(reste) ?? resoudreProbleme(reste);
    if (probleme.resolu) {
      return { sortie: formuleReponse(probleme), exitCode: 0, commande: "calc", dureeMs: Date.now() - debut };
    }
    // …sinon l'expression brute.
    const v = evaluerExpression(reste);
    if (v === null) {
      return { sortie: `Expression non calculable : « ${reste.slice(0, 120)} »`, exitCode: 1, commande: "calc", dureeMs: Date.now() - debut };
    }
    return { sortie: `${formaterNombre(v)}`, exitCode: 0, commande: "calc", dureeMs: Date.now() - debut };
  }

  private cmdJs(reste: string): ResultatTerminal {
    const debut = Date.now();
    if (reste.length === 0) {
      return { sortie: "Usage : js <code> (ex : js 2**10)", exitCode: 1, commande: "js", dureeMs: Date.now() - debut };
    }
    const lignesConsole: string[] = [];
    const consoleCapte = {
      log: (...args: unknown[]) => {
        if (lignesConsole.length < 50) {
          lignesConsole.push(args.map((a) => (typeof a === "string" ? a : serialiserValeur(a))).join(" "));
        }
      },
    };
    // SANDBOX (défense en profondeur) : createContext + runInContext créent
    // un CONTEXTE NEUF avec ses PROPREs intrinsics (Math, JSON, Array,
    // Object…) — la monnaie du sandbox n'est PAS la nôtre : un monkey-patch
    // de Math dans le sandbox ne touche jamais l'hôte. Le sandbox n'expose
    // QUE la console capturée : ni process, ni require, ni Buffer, ni
    // réseau, ni disque. contextCodeGeneration (option de CRÉATION du
    // contexte) interdit eval/Function DANS le sandbox ; le timeout du vm
    // tue toute boucle infinie.
    const sandbox = { console: consoleCapte };
    let sortie = "";
    let exitCode = 0;
    try {
      const contexte = createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
      });
      const valeur: unknown = runInContext(reste, contexte, {
        timeout: TIMEOUT_VM_MS,
        displayErrors: true,
      });
      sortie =
        (lignesConsole.length ? `${lignesConsole.join("\n")}\n` : "") +
        serialiserValeur(valeur);
    } catch (error) {
      exitCode = 1;
      const message = error instanceof Error ? error.message : String(error);
      sortie = `Erreur d'exécution sandbox : ${message}`;
      if (lignesConsole.length) sortie += `\nSortie console avant l'erreur :\n${lignesConsole.join("\n")}`;
    }
    return { sortie: tronquer(sortie), exitCode, commande: "js", dureeMs: Date.now() - debut };
  }

  private cmdMonde(reste: string): ResultatTerminal {
    const debut = Date.now();
    if (!this.env.monde) {
      return { sortie: "Compartiment monde non câblé à ce terminal.", exitCode: 1, commande: "monde", dureeMs: Date.now() - debut };
    }
    if (reste.length === 0) {
      return {
        sortie: `Usage : monde <question>. Familles : ${this.env.monde.capacites().join(", ")}`,
        exitCode: 1,
        commande: "monde",
        dureeMs: Date.now() - debut,
      };
    }
    const r = this.env.monde.repondre(reste);
    if (!r) {
      return {
        sortie: "Le monde virtuel n'a pas reconnu une simulation assez certaine dans cette question. Précisez le scénario (ex : « projectile lancé à 20 m/s avec un angle de 45 degrés »).",
        exitCode: 1,
        commande: "monde",
        dureeMs: Date.now() - debut,
      };
    }
    return { sortie: r.texte, exitCode: 0, commande: "monde", dureeMs: Date.now() - debut };
  }

  private cmdMemoire(reste: string): ResultatTerminal {
    const debut = Date.now();
    const memoire = this.env.memoireDomaines;
    if (!memoire) {
      return { sortie: "Mémoire de domaines non câblée à ce terminal.", exitCode: 1, commande: "memoire", dureeMs: Date.now() - debut };
    }
    const morceaux = reste.split(/\s+/).filter(Boolean);
    if (morceaux.length === 0) {
      return { sortie: "Usage : memoire <domaine> [capacite] (ex : memoire math texte)", exitCode: 1, commande: "memoire", dureeMs: Date.now() - debut };
    }
    const etat = memoire.etatCompartiment(morceaux[0]!, morceaux[1] ?? "texte");
    const lignes = [
      `Compartiment ${etat.cle} — quota ${formaterGo(etat.quotaOctets)}`,
      `physique mesuré : ${formaterGo(etat.octetsPhysiques)} (réels ${formaterGo(etat.octetsReels)}, graines ${formaterGo(etat.octetsGraine)}, ingérés ${formaterGo(etat.octetsInges)})`,
      `couverture : ${(etat.tauxCouverturePhysique * 100).toFixed(4)} % — écart restant ${formaterGo(etat.ecartRestantOctets)}`,
      `expansion déterministe : ${etat.expansionDeterministe ? "oui" : "non"} — unités adressables : ${etat.unitesAdressables}`,
    ];
    return { sortie: lignes.join("\n"), exitCode: 0, commande: "memoire", dureeMs: Date.now() - debut };
  }

  private cmdSources(reste: string): ResultatTerminal {
    const debut = Date.now();
    const memoire = this.env.memoireDomaines;
    if (!memoire) {
      return { sortie: "Mémoire de domaines non câblée à ce terminal.", exitCode: 1, commande: "sources", dureeMs: Date.now() - debut };
    }
    const domaine = reste.split(/\s+/)[0] ?? "";
    if (!domaine) {
      return { sortie: "Usage : sources <domaine> (ex : sources math)", exitCode: 1, commande: "sources", dureeMs: Date.now() - debut };
    }
    const sources = memoire.sourcesDomaine(domaine);
    if (sources.length === 0) {
      return { sortie: `Aucune source enregistrée pour « ${domaine} » (registre honnête — rien d'inventé).`, exitCode: 1, commande: "sources", dureeMs: Date.now() - debut };
    }
    const lignes = sources.map(
      (s) => `${s.plateforme} · ${s.nom} · ${s.statut} · ${s.emplacement} (${s.reference})`,
    );
    return { sortie: lignes.join("\n"), exitCode: 0, commande: "sources", dureeMs: Date.now() - debut };
  }

  private cmdEtat(): ResultatTerminal {
    const debut = Date.now();
    const memoire = this.env.memoireDomaines;
    if (!memoire) {
      return { sortie: "Mémoire de domaines non câblée à ce terminal.", exitCode: 1, commande: "etat", dureeMs: Date.now() - debut };
    }
    const s = memoire.statistiques();
    const lignes = [
      `Mémoire de domaines — ${s.compartiments} compartiments (19 domaines × 7 capacités, quota 1 Go chacun)`,
      `physique : réels ${formaterGo(s.octetsReels)} · ingérés ${formaterGo(s.octetsInges)} · ${s.enseignements} enseignement(s)`,
    ];
    return { sortie: lignes.join("\n"), exitCode: 0, commande: "etat", dureeMs: Date.now() - debut };
  }

  private cmdHistorique(): ResultatTerminal {
    const debut = Date.now();
    if (this.historique.length === 0) {
      return { sortie: "Historique vide.", exitCode: 0, commande: "historique", dureeMs: Date.now() - debut };
    }
    const lignes = this.historique
      .slice(-20)
      .map((h, i) => `${i + 1}. [${h.exitCode}] ${h.commande} (${h.dureeMs} ms)`);
    return { sortie: lignes.join("\n"), exitCode: 0, commande: "historique", dureeMs: Date.now() - debut };
  }

  // ─── Lecture (orchestrateur + API) ─────────────────────────────────────────

  litHistorique(): readonly EntreeHistorique[] {
    return this.historique;
  }

  statistiques(): { commandes: number; parCommande: Record<string, number>; echecs: number } {
    const parCommande: Record<string, number> = {};
    let echecs = 0;
    for (const [c, n] of this.compteurParCommande.entries()) parCommande[c] = n;
    for (const h of this.historique) if (h.exitCode !== 0) echecs += 1;
    return { commandes: this.historique.length, parCommande, echecs };
  }
}

function formaterGo(octets: number): string {
  if (octets >= 1e9) return `${(Math.round((octets / 1e9) * 1e4) / 1e4).toString().replace(".", ",")} Go`;
  if (octets >= 1e6) return `${(Math.round((octets / 1e6) * 100) / 100).toString().replace(".", ",")} Mo`;
  if (octets >= 1e3) return `${Math.round(octets / 1e3)} ko`;
  return `${octets} o`;
}
