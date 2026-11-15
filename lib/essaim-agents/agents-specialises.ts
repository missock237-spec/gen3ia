/**
 * Les cinq mini-agents spécialisés de l'essaim Gen3ia.
 *
 * Chaque agent est une unité d'exécution pure, déterministe et
 * instantanée — volontairement sans réseau, sans I/O et sans dépendance
 * au cloud : il reçoit une charge JSON compacte et renvoie un résultat
 * normalisé. La spécialisation « calcul » réutilise le parseur d'AST
 * sûr du Monde (lib/monde/expression.ts) : jamais d'`eval`, jamais de
 * code étranger exécuté en confiance.
 *
 * Tous les agents sont connectés à l'IA principale Gen3 via
 * l'orchestrateur : aucun ne décide seul, chacun compte-rend.
 */

import { compilerExpression, ErreurExpression } from "@/lib/monde/expression";

import type {
  ResultatAgent,
  TacheAgent,
  TypeAgent,
} from "./types";

/** Contrat commun de tout mini-agent exécutant. */
export interface AgentExecutant {
  readonly type: TypeAgent;
  readonly nom: string;
  readonly description: string;
  executer(tache: TacheAgent): ResultatAgent;
}

/** Borde une chaîne reçue (honnêteté : jamais de mémoire infinie). */
function borne(texte: unknown, max: number): string {
  return typeof texte === "string" ? texte.slice(0, max) : "";
}

/** Borde un tableau reçu. */
function borneTableau<T>(valeur: unknown, max: number): T[] {
  return Array.isArray(valeur) ? (valeur as T[]).slice(0, max) : [];
}

function confiance(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/* ------------------------------------------------------------------ */
/* 1. Agent de veille — détection de changements entre deux états      */
/* ------------------------------------------------------------------ */

interface SignalVeille {
  cle: string;
  valeur: string;
}

export class AgentVeille implements AgentExecutant {
  readonly type: TypeAgent = "veille";
  readonly nom = "Sentinelle";
  readonly description =
    "Surveille un sujet : compare deux instantanés et signale chaque rupture de signal.";

  executer(tache: TacheAgent): ResultatAgent {
    const sujet = borne(tache.charge.sujet, 200) || "sujet non nommé";
    const avant = borneTableau<SignalVeille>(tache.charge.avant, 64);
    const apres = borneTableau<SignalVeille>(tache.charge.apres, 64);
    if (avant.length === 0 && apres.length === 0) {
      return {
        resume: `Veille « ${sujet} » : aucun signal fourni, rien à comparer.`,
        confiance: 0.2,
      };
    }

    const carteAvant = new Map(avant.map((s) => [s.cle, s.valeur]));
    const carteApres = new Map(apres.map((s) => [s.cle, s.valeur]));

    const ajoutes: string[] = [];
    const modifies: string[] = [];
    const supprimes: string[] = [];
    for (const [cle, valeur] of carteApres) {
      if (!carteAvant.has(cle)) ajoutes.push(cle);
      else if (carteAvant.get(cle) !== valeur) modifies.push(cle);
    }
    for (const cle of carteAvant.keys()) {
      if (!carteApres.has(cle)) supprimes.push(cle);
    }

    const ruptures = ajoutes.length + modifies.length + supprimes.length;
    const parties: string[] = [];
    if (ajoutes.length) parties.push(`${ajoutes.length} signal(s) nouveau(x)`);
    if (modifies.length) parties.push(`${modifies.length} signal(s) modifié(s)`);
    if (supprimes.length) parties.push(`${supprimes.length} signal(s) disparu(s)`);

    return {
      resume: ruptures
        ? `Veille « ${sujet} » : rupture détectée — ${parties.join(", ")}.`
        : `Veille « ${sujet} » : le signal est stable, aucun changement.`,
      donnees: { ajoutes, modifies, supprimes, ruptures },
      confiance: confiance(0.85),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 2. Agent de tri — classification par critères pondérés              */
/* ------------------------------------------------------------------ */

export class AgentTri implements AgentExecutant {
  readonly type: TypeAgent = "tri";
  readonly nom = "Classeur";
  readonly description =
    "Trie et classe des éléments par critères : compte par catégorie, ordonne par pertinence.";

  executer(tache: TacheAgent): ResultatAgent {
    const elements = borneTableau<string>(tache.charge.elements, 256).map((e) =>
      borne(e, 400),
    );
    const criteres = borneTableau<string>(tache.charge.criteres, 12).map((c) =>
      borne(c, 60).toLowerCase(),
    );
    if (elements.length === 0) {
      return { resume: "Tri : aucun élément fourni.", confiance: 0.1 };
    }
    if (criteres.length === 0) {
      // Sans critère : tri lexicographique simple et honnête.
      const tries = [...elements].sort((a, b) => a.localeCompare(b, "fr"));
      return {
        resume: `Tri : ${elements.length} élément(s) ordonné(s) alphabétiquement.`,
        donnees: { tries: tries.slice(0, 64) },
        confiance: confiance(0.6),
      };
    }

    const repartition = new Map<string, string[]>(criteres.map((c) => [c, []]));
    const nonClasse: string[] = [];
    for (const element of elements) {
      const bas = element.toLowerCase();
      let meilleur = "";
      let meilleurScore = 0;
      for (const critere of criteres) {
        // Score : occurrences du critère dans l'élément (pondéré par sa longueur).
        const occurrences = bas.split(critere).length - 1;
        const score = occurrences > 0 ? occurrences * (critere.length / Math.max(1, bas.length)) : 0;
        if (score > meilleurScore) {
          meilleurScore = score;
          meilleur = critere;
        }
      }
      if (meilleur) repartition.get(meilleur)!.push(element);
      else nonClasse.push(element);
    }

    const synthese = [...repartition.entries()]
      .filter(([, liste]) => liste.length > 0)
      .map(([critere, liste]) => `${critere}: ${liste.length}`)
      .join(", ");

    return {
      resume: `Tri : ${elements.length} élément(s) réparti(s) sur ${criteres.length} critère(s)${
        synthese ? ` — ${synthese}` : ""
      }${nonClasse.length ? ` ; ${nonClasse.length} non classé(s)` : ""}.`,
      donnees: {
        repartition: Object.fromEntries([...repartition.entries()].map(([c, l]) => [c, l.slice(0, 32)])),
        nonClasse: nonClasse.slice(0, 32),
      },
      confiance: confiance(nonClasse.length === 0 ? 0.9 : 0.7),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 3. Agent de calcul — AST sûr du Monde + statistiques                */
/* ------------------------------------------------------------------ */

export class AgentCalcul implements AgentExecutant {
  readonly type: TypeAgent = "calcul";
  readonly nom = "Arithmètre";
  readonly description =
    "Résout des expressions mathématiques via l'AST sûr du Monde et calcule des statistiques descriptives.";

  executer(tache: TacheAgent): ResultatAgent {
    const expression = borne(tache.charge.expression, 512).trim();
    const valeurs = borneTableau<number>(tache.charge.valeurs, 4096).filter((v) =>
      typeof v === "number" && Number.isFinite(v),
    );

    if (expression) {
      try {
        const compilee = compilerExpression(expression);
        const valeur = compilee.evaluer({});
        if (!Number.isFinite(valeur)) {
          return {
            resume: `Calcul « ${expression} » : le résultat n'est pas un nombre fini.`,
            confiance: 0.3,
          };
        }
        return {
          resume: `Calcul : ${expression} = ${valeur}`,
          donnees: { expression, valeur },
          confiance: confiance(0.95),
        };
      } catch (e) {
        const motif = e instanceof ErreurExpression ? e.message : "expression illisible";
        return { resume: `Calcul « ${expression} » refusé : ${motif}.`, confiance: 0.2 };
      }
    }

    if (valeurs.length > 0) {
      const n = valeurs.length;
      const somme = valeurs.reduce((a, b) => a + b, 0);
      const moyenne = somme / n;
      const trie = [...valeurs].sort((a, b) => a - b);
      const mediane =
        n % 2 === 1 ? trie[(n - 1) / 2] : (trie[n / 2 - 1] + trie[n / 2]) / 2;
      const variance = valeurs.reduce((a, v) => a + (v - moyenne) ** 2, 0) / n;
      return {
        resume: `Statistiques sur ${n} valeur(s) : moyenne ${moyenne.toFixed(4)}, médiane ${mediane.toFixed(4)}, écart-type ${Math.sqrt(variance).toFixed(4)}.`,
        donnees: {
          n,
          moyenne,
          mediane,
          ecartType: Math.sqrt(variance),
          minimum: trie[0],
          maximum: trie[n - 1],
        },
        confiance: confiance(0.95),
      };
    }

    return {
      resume: "Calcul : ni expression ni valeurs reçues — rien à résoudre.",
      confiance: 0.1,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 4. Agent de code — analyse statique légère                          */
/* ------------------------------------------------------------------ */

const MOTIFS_SUSPECTS: Array<[string, RegExp]> = [
  ["eval", /\beval\s*\(/],
  ["exécution de commande", /\b(child_process|execSync|spawn)\b/],
  ["accès réseau", /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/],
  ["stockage", /\b(localStorage|sessionStorage|indexedDB)\b/],
  ["contournement de portée", /\b(globalThis|window\.|document\.)\b/],
];

export class AgentCode implements AgentExecutant {
  readonly type: TypeAgent = "code";
  readonly nom = "Lecteur de code";
  readonly description =
    "Analyse un extrait de code : métriques, fonctions détectées, motifs risqués.";

  executer(tache: TacheAgent): ResultatAgent {
    const code = borne(tache.charge.code, 16 * 1024);
    if (!code.trim()) {
      return { resume: "Code : aucun extrait fourni.", confiance: 0.1 };
    }

    const lignes = code.split("\n").length;
    const fonctions = [
      ...code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g),
      ...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g),
      ...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*[^)]*\)\s*\{/g),
    ].map((m) => m[1]);
    const fonctionsUniques = [...new Set(fonctions)].slice(0, 32);

    // Complexité cyclomatique approximée : décisions + 1.
    const decisions = (code.match(/\b(if|for|while|case|catch)\b/g) ?? []).length;
    const complexite = decisions + 1;

    const risques = MOTIFS_SUSPECTS.filter(([, motif]) => motif.test(code)).map(([nom]) => nom);

    const todo = (code.match(/\b(TODO|FIXME|HACK)\b/g) ?? []).length;

    return {
      resume:
        `Code : ${lignes} ligne(s), ${fonctionsUniques.length} fonction(s) détectée(s), ` +
        `complexité ≈ ${complexite}` +
        (risques.length ? `, motifs risqués : ${risques.join(", ")}` : ", aucun motif risqué") +
        (todo ? `, ${todo} marqueur(s) TODO/FIXME` : ""),
      donnees: {
        lignes,
        fonctions: fonctionsUniques,
        complexite,
        risques,
        todo,
      },
      confiance: confiance(0.75),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 5. Agent d'automatisation — chaînage de mini-tâches locales         */
/* ------------------------------------------------------------------ */

interface EtapeChaine {
  type: TypeAgent;
  charge: Record<string, unknown>;
}

/** Agents exécutables en sous-tâche (l'automatisation ne se chaîne pas elle-même). */
function agentPourType(type: TypeAgent): AgentExecutant | null {
  switch (type) {
    case "veille": return new AgentVeille();
    case "tri": return new AgentTri();
    case "calcul": return new AgentCalcul();
    case "code": return new AgentCode();
    default: return null; // "automatisation" : récursion interdite.
  }
}

export class AgentAutomatisation implements AgentExecutant {
  readonly type: TypeAgent = "automatisation";
  readonly nom = "Chaîneur";
  readonly description =
    "Exécute une séquence de mini-tâches (veille, tri, calcul, code) et assemble le compte-rendu global.";

  executer(tache: TacheAgent): ResultatAgent {
    const etapes = borneTableau<EtapeChaine>(tache.charge.etapes, 12);
    if (etapes.length === 0) {
      return { resume: "Automatisation : aucune étape fournie.", confiance: 0.1 };
    }

    const comptesRendus: Array<{ etape: number; type: TypeAgent; resume: string; confiance: number }> = [];
    let echecs = 0;
    for (let i = 0; i < etapes.length; i++) {
      const etape = etapes[i];
      const agent = agentPourType(etape.type);
      if (!agent || etape.type === "automatisation") {
        comptesRendus.push({
          etape: i + 1,
          type: etape.type,
          resume: "étape ignorée : type inconnu ou récursif interdit",
          confiance: 0,
        });
        echecs++;
        continue;
      }
      try {
        const sousTache: TacheAgent = {
          ...tache,
          type: etape.type,
          charge: etape.charge,
        };
        const resultat = agent.executer(sousTache);
        comptesRendus.push({
          etape: i + 1,
          type: etape.type,
          resume: resultat.resume,
          confiance: resultat.confiance,
        });
        if (resultat.confiance < 0.5) echecs++;
      } catch {
        comptesRendus.push({
          etape: i + 1,
          type: etape.type,
          resume: "étape en échec",
          confiance: 0,
        });
        echecs++;
      }
    }

    const confianceGlobale = confiance(1 - echecs / etapes.length);
    return {
      resume:
        `Automatisation : ${etapes.length} étape(s) chaînée(s), ${etapes.length - echecs} réussie(s)` +
        ` — ${comptesRendus.map((c) => `${c.etape}.${c.type}`).join(" → ")}.`,
      donnees: { comptesRendus },
      confiance: confianceGlobale,
    };
  }
}

/** Instances partagées (sans état mutable : réutilisables partout). */
export function creerAgentsParType(): Record<TypeAgent, AgentExecutant> {
  const automatisation = new AgentAutomatisation();
  return {
    veille: new AgentVeille(),
    tri: new AgentTri(),
    calcul: new AgentCalcul(),
    code: new AgentCode(),
    automatisation,
  };
}
